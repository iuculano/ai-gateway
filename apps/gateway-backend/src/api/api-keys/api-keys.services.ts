import { createHash, randomBytes } from 'node:crypto';
import { invalidateGenericKeyAuthCache } from '@repo/auth';
import { diffFields, probe, toPage } from '@repo/core';
import { and, db, desc, eq, isNull, lt } from '@repo/drizzle';
import { apiKeys } from '@repo/drizzle/schemas';
import { type Caller, getAccountableUserId, getCaller } from '@repo/hono';
import { redis } from '@repo/redis';
import { err, ok, type Result } from 'neverthrow';
import AuditLogServices from '../audit-logs/audit-logs.services';
import Schemas, {
  type CreateApiKeyBody,
  type CreateApiKeyResponse,
  type GetApiKeyResponse,
  type GetApiKeyStatsResponse,
  type ListApiKeysQuery,
  type ListApiKeysResponse,
  type RevokeApiKeyResponse,
  type UpdateApiKeyBody,
  type UpdateApiKeyResponse,
} from './api-keys.schemas';

/**
 * A stored API key row, as the transactions below hand it back before it is
 * parsed into a response shape.
 */
type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * The outcomes of a lookup that the caller can do something about.
 *
 * Everything else - a query that fails, a row that will not parse - is the
 * system malfunctioning rather than an answer, and rejects.
 */
export type GetApiKeyFailure = {
  code: 'API_KEY_NOT_FOUND';
  id: string;
};

/**
 * Statistics are gated on the same lookup, so they refuse for the same reason.
 */
export type GetApiKeyStatsFailure = {
  code: 'API_KEY_NOT_FOUND';
  id: string;
};

/**
 * Creation refuses only for scopes: everything else about a create either
 * succeeds or is a malfunction.
 */
export type CreateApiKeyFailure = {
  code: 'UNGRANTABLE_SCOPES';
  held: string[];
  ungrantable: string[];
};

export type UpdateApiKeyFailure =
  | {
      code: 'UNGRANTABLE_SCOPES';
      held: string[];
      ungrantable: string[];
    }
  | {
      code: 'API_KEY_NOT_FOUND';
      id: string;
    }
  | {
      code: 'API_KEY_REVOKED';
      id: string;
    }
  | {
      code: 'RATE_LIMIT_WINDOW_REQUIRED';
      id: string;
    };

/**
 * Revocation is idempotent, so revoking an already revoked key is a success
 * rather than a refusal. Only a key that does not exist at all is a failure.
 */
export type RevokeApiKeyFailure = {
  code: 'API_KEY_NOT_FOUND';
  id: string;
};

/**
 * SHA-256 hex digest of a plaintext key. That's it.
 *
 * @param key
 * The plaintext API key to hash.
 *
 * @returns
 * The SHA-256 hex digest of the API key.
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function apiKeyQuotaKey(id: string): string {
  return `api-keys:quota:${id}`;
}

/**
 * Retrieves a single API key by its ID.
 *
 * @param id
 * The ID of the API key to retrieve.
 */
async function getApiKey(id: string): Promise<Result<GetApiKeyResponse, GetApiKeyFailure>> {
  const caller = getCaller();

  // biome-ignore format: looks nicer
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.organization_id, caller.organization.id),
      eq(apiKeys.id, id)
    ));

  if (!row) {
    return err({ code: 'API_KEY_NOT_FOUND', id });
  }

  const parsed = Schemas.getApiKey.response.parse(row);
  return ok(parsed);
}

/**
 * Get the usage stats of an API key.
 *
 * @param id
 * The ID of the API key to read stats for.
 */
async function getApiKeyStats(id: string): Promise<Result<GetApiKeyStatsResponse, GetApiKeyStatsFailure>> {
  // Need to try to actually grab a key first, can't just hit redis blindly
  // because that would effectively let us return the stats for _any_ key,
  // even if it belongs to another organization.
  const found = await getApiKey(id);
  if (found.isErr()) {
    return err(found.error);
  }

  const key = found.value;
  const quotaKey = apiKeyQuotaKey(id);

  // Grab the redis state for this key.
  // biome-ignore format: looks nicer
  const [usage, counter, pttl] = await redis
    .multi()
    .hGetAll(`api-keys:usage:${id}`) // total_requests, last_used_at
    .get(quotaKey) // current fixed-window count
    .pTTL(quotaKey) // ms left in the window
    .execTyped();

  // usage is never null: a key that has never been used comes back as an empty
  // object, and a Redis command that fails rejects the whole exec.
  //
  // Individual fields can be absent, which is what the checks below cover.
  const limit = key.rate_limit_requests;
  const used = limit == null ? null : Number(counter ?? 0);

  // pTTL is -2 when the counter has expired or was never created, and -1 if it
  // somehow exists without an expiry.
  const isRateLimiting = pttl > 0;

  return ok(
    Schemas.getApiKeyStats.response.parse({
      id: key.id,
      total_requests: Number(usage.total_requests ?? 0), // if unused
      last_used_at: usage.last_used_at ? new Date(Number(usage.last_used_at)) : null,

      current_window:
        limit == null || used == null || !isRateLimiting
          ? null
          : {
              limit,
              used,
              remaining: Math.max(0, limit - used),
              resets_at: new Date(Date.now() + pttl),
            },
    }),
  );
}

/**
 * Lifetime request counts for a set of key ids.
 *
 * Issued in one tick so node-redis pipelines them into a single round trip - a
 * full 250 row page costs one write, not 250.
 *
 * A key that has never authenticated a request has no usage hash at all, which
 * reads as 0 rather than as missing: the table renders this as a count, and
 * "never used" is a real answer, not an absent one.
 *
 * @param ids
 * The API key IDs to read counts for.
 */
async function getTotalRequests(ids: string[]): Promise<Map<string, number>> {
  const counts = await Promise.all(ids.map((id) => redis.hGet(`api-keys:usage:${id}`, 'total_requests')));

  return new Map(ids.map((id, index) => [id, Number(counts[index] ?? 0)]));
}

/**
 * Retrieves a list of API keys, filtered by the given criteria.
 *
 * Results are returned newest-first.
 *
 * Deliberately not a Result: an empty page is a page, and there is no outcome
 * here the caller could correct. A Result<_, never> would only make every call
 * site unwrap something that cannot happen.
 *
 * @param query
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the API key data.
 */
async function listApiKeys(query: ListApiKeysQuery): Promise<ListApiKeysResponse> {
  const caller = getCaller();

  const conditions = [
    eq(apiKeys.organization_id, caller.organization.id),
    query.after_id ? lt(apiKeys.id, query.after_id) : undefined,
    query.status === 'active' ? isNull(apiKeys.revoked_at) : undefined,
  ];

  // biome-ignore format: looks nicer
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(...conditions))
    .orderBy(desc(apiKeys.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);

  // After toPage, not before - the probe row is discarded there, and reading a
  // count for it would be a wasted redis command every single page.
  const totals = await getTotalRequests(page.data.map((row) => row.id));
  const hydratedRows = page.data.map((row) => ({
    ...row,
    total_requests: totals.get(row.id) ?? 0,
  }));

  return Schemas.listApiKeys.response.parse({
    data: hydratedRows,
    meta: page.meta,
  });
}

/**
 * Helper to figure out if we're trying to do something dumb with scopes, like
 * privilege escalation. A caller can only grant scopes it holds itself.
 *
 * A query rather than an assertion, because both callers record the refusal
 * under their own event name before returning it - an assertion would make them
 * catch an exception thrown a line earlier to do it.
 *
 * @param caller
 * The authenticated caller.
 *
 * @param scopes
 * Scopes we're trying to grant. Space-separated.
 *
 * @returns
 * An object representing the scopes the caller holds and the ones it cannot
 * grant.
 */
function checkScopes(caller: Caller, scopes: string): { held: string[]; ungrantable: string[] } {
  const requested = scopes.split(' ').filter(Boolean);
  const held = new Set(caller.permissions.scopes);
  const ungrantable = requested.filter((scope) => !held.has(scope));

  return {
    held: [...held],
    ungrantable: ungrantable,
  };
}

/**
 * Creates a new API key.
 *
 * @param body
 * The request object containing the API key data to be created.
 *
 * @returns
 * A promise that resolves to the created API key data, including the
 * plaintext key.
 */
async function createApiKey(body: CreateApiKeyBody): Promise<Result<CreateApiKeyResponse, CreateApiKeyFailure>> {
  const caller = getCaller();

  // A caller can only grant scopes it holds itself so we don't have a privilege
  // escalation problem.
  if (body.scopes !== undefined) {
    const { held, ungrantable } = checkScopes(caller, body.scopes);

    if (ungrantable.length > 0) {
      // Swallowed so the refusal below is what reaches the caller - a failed
      // write about the refusal must not replace the refusal itself. This is
      // the one place a failed audit write is deliberately dropped.
      await AuditLogServices.createAuditLog({
        event: 'api-keys.created',
        target_type: 'api_key',
        status: 'failure',
        metadata: { name: body.name, reason: 'ungrantable_scopes' },
      }).catch(() => {});

      return err({ code: 'UNGRANTABLE_SCOPES', held, ungrantable });
    }
  }

  // Generate a new API key, 64 characters total.
  // Make the prefix customizable?
  const key = `aik_${randomBytes(30).toString('hex')}`;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        ...body,
        organization_id: caller.organization.id,
        creator_id: getAccountableUserId(caller),
        key_hash: hashApiKey(key),
      })
      .returning();

    if (!row) {
      // Mysterious database persistence failure, not a refusal...
      // Should probaly never land here in practice, just throw...
      throw new Error('Failed to insert API key');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'api-keys.created',
        target_type: 'api_key',
        target_id: row.id,
        status: 'success',
        metadata: { name: row.name },
      },
      tx,
    );

    return row;
  });

  const parsed = Schemas.createApiKey.response.parse({
    ...result,
    key: key,
  });

  return ok(parsed);
}

/**
 * Updates an existing API key.
 *
 * The field-level before/after difference is written to the audit log in
 * the same transaction.
 *
 * @param id
 * The ID of the API key to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated API key data.
 */
async function updateApiKey(
  id: string,
  body: UpdateApiKeyBody,
): Promise<Result<UpdateApiKeyResponse, UpdateApiKeyFailure>> {
  const caller = getCaller();

  // A caller can only grant scopes it holds itself so we don't have a privilege
  // escalation problem.
  if (body.scopes !== undefined) {
    const { held, ungrantable } = checkScopes(caller, body.scopes);

    if (ungrantable.length > 0) {
      // Swallowed so the refusal below is what reaches the caller - a failed
      // write about the refusal must not replace the refusal itself. This is
      // the one place a failed audit write is deliberately dropped.
      await AuditLogServices.createAuditLog({
        event: 'api-keys.updated',
        target_type: 'api_key',
        target_id: id, // Unlike creation, the target already exists here.
        status: 'failure',
        metadata: { reason: 'ungrantable_scopes' },
      }).catch(() => {});

      return err({ code: 'UNGRANTABLE_SCOPES', held, ungrantable });
    }
  }

  const result = await db.transaction(async (tx): Promise<Result<ApiKeyRow, UpdateApiKeyFailure>> => {
    // biome-ignore format: looks nicer
    const [existing] = await tx
      .select()
      .from(apiKeys)
      .where(and(
        eq(apiKeys.organization_id, caller.organization.id),
        eq(apiKeys.id, id)
      ))
      .for('update');

    if (!existing) {
      return err({ code: 'API_KEY_NOT_FOUND', id });
    }

    if (existing.revoked_at) {
      return err({ code: 'API_KEY_REVOKED', id });
    }

    // Source writable fields from the schema.
    const writeableFields = Object.keys(Schemas.updateApiKey.body.shape);
    const { updates, difference } = diffFields(existing, body, writeableFields);

    // Can just bail early if the diff is empty.d
    if (Object.keys(difference).length === 0) {
      return ok(existing);
    }

    // Validate the merged policy because a PATCH may supply only one field.
    // Ignore invalid legacy policies during unrelated updates.
    const touchesRateLimit = 'rate_limit_requests' in updates || 'rate_limit_window' in updates;
    const merged = { ...existing, ...updates };

    if (touchesRateLimit && merged.rate_limit_requests != null && merged.rate_limit_window == null) {
      return err({ code: 'RATE_LIMIT_WINDOW_REQUIRED', id });
    }

    // biome-ignore format: looks nicer
    const [row] = await tx
      .update(apiKeys)
      .set(updates)
      .where(and(
        eq(apiKeys.organization_id, caller.organization.id),
        eq(apiKeys.id, id)
      ))
      .returning();

    // Likely a database malfunction rather than a refusal, just throw...
    if (!row) {
      throw new Error('Failed to update API key');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'api-keys.updated',
        target_type: 'api_key',
        target_id: row.id,
        status: 'success',
        difference: difference,
      },
      tx,
    );

    // Reset an API key’s active rate-limit counter when its policy changes.
    const rateLimitChanged = 'rate_limit_requests' in difference || 'rate_limit_window' in difference;
    if (rateLimitChanged) {
      await redis.del(apiKeyQuotaKey(row.id));
    }

    await invalidateGenericKeyAuthCache(row.key_hash);

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.updateApiKey.response.parse(result.value);
  return ok(parsed);
}

/**
 * Revokes an existing API key.
 *
 * Keys are not hard-deleted. Revocation preserves the row for the audit
 * trail and for introspection of historical usage. Revoking an already
 * revoked key is a no-op.
 *
 * @param id
 * The ID of the API key to revoke.
 */
async function revokeApiKey(id: string): Promise<Result<RevokeApiKeyResponse, RevokeApiKeyFailure>> {
  const caller = getCaller();

  return db.transaction(async (tx): Promise<Result<RevokeApiKeyResponse, RevokeApiKeyFailure>> => {
    // biome-ignore format: please biome stop messing with this
    const [row] = await tx
      .update(apiKeys)
      .set({
        revoked_at: new Date(),
        revoked_by: getAccountableUserId(caller),
      })
      .where(and(
        eq(apiKeys.organization_id, caller.organization.id),
        eq(apiKeys.id, id),
        isNull(apiKeys.revoked_at)
      ))
      .returning();

    // Failure at this point is ambiguous. If we got back no rows, the key is
    // either already revoked or doesn't exist - need to check which case it
    // is.
    if (!row) {
      // If just a select returns nothing here, the key outright doesn't exist.
      // biome-ignore format: again this makes it uglier
      const [existing] = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organization_id, caller.organization.id),
          eq(apiKeys.id, id)
        ));

      if (!existing) {
        return err({ code: 'API_KEY_NOT_FOUND', id });
      }

      // Already revoked. Revocation is idempotent, so this is a success with
      // nothing left to do.
      return ok(undefined);
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'api-keys.revoked',
        target_type: 'api_key',
        target_id: row.id,
        status: 'success',

        // Stated rather than diffed.
        difference: {
          revoked_at: { old: null, new: row.revoked_at },
          revoked_by: { old: null, new: row.revoked_by },
        },
      },
      tx,
    );

    await invalidateGenericKeyAuthCache(row.key_hash);

    return ok(undefined);
  });
}

export default {
  getApiKey,
  getApiKeyStats,
  listApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
};
