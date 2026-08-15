import { diffFields, probe, toPage } from '@repo/core';
import { and, asc, db, desc, eq, inArray, lt } from '@repo/drizzle';
import { type GuardrailRow, guardrails } from '@repo/drizzle/schemas';
import { getAccountableUserId, getCaller, getLogger } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import AuditLogServices from '../audit-logs/audit-logs.services';
import { findMatches, sidesFor } from './guardrails.evaluation';
import Schemas, {
  type CreateRegexGuardrailBody,
  type CreateRegexGuardrailResponse,
  type DeleteGuardrailResponse,
  type EvaluateGuardrailsBody,
  type EvaluateGuardrailsResponse,
  type EvaluationResult,
  type GetGuardrailResponse,
  type ListGuardrailsQuery,
  type ListGuardrailsResponse,
  regexConfig,
  type UpdateRegexGuardrailBody,
  type UpdateRegexGuardrailResponse,
} from './guardrails.schemas';

/**
 * The outcomes a caller can act on.
 *
 * Declared per operation rather than shared, so a code added to one cannot
 * silently widen the others. Everything else here - a failed query, a row that
 * will not parse, an insert that returns nothing - is the system malfunctioning
 * rather than an answer, and rejects.
 */
export type GetGuardrailFailure = {
  code: 'GUARDRAIL_NOT_FOUND';
  id: string;
};

export type UpdateRegexGuardrailFailure = {
  code: 'GUARDRAIL_NOT_FOUND';
  id: string;
};

export type DeleteGuardrailFailure = {
  code: 'GUARDRAIL_NOT_FOUND';
  id: string;
};

/**
 * Runs one guardrail against one side.
 *
 * A guardrail that cannot run comes back failed, carrying the reason, rather
 * than being quietly dropped: this is a safety control, and a silently skipped
 * one reads as a pass to everything downstream.
 */
function evaluateOne(row: GuardrailRow, target: 'request' | 'response', content: string): EvaluationResult {
  const base = {
    guardrail_id: row.id,
    name: row.name,
    type: row.type,
    target: target,
    action: row.action,
  };

  // Re-parsed on read rather than trusted. `config` is jsonb, so the column
  // guarantees only that it is json - the shape was checked when the row was
  // written through the API, and a row that arrived any other way was never
  // checked at all.
  const config = regexConfig.safeParse(row.config);
  if (!config.success) {
    getLogger().error({ guardrail_id: row.id }, 'Guardrail has a malformed config and cannot be evaluated');

    return { ...base, passed: false, matches: [], error: 'guardrail config is malformed' };
  }

  try {
    const matches = findMatches(config.data, content);

    // A match IS the violation: patterns here describe what must not appear.
    // An allow-list guardrail ("must match, or fail") would be a second type,
    // not a flag on this one.
    return { ...base, passed: matches.length === 0, matches: matches, error: null };
  } catch (error) {
    getLogger().error({ err: error, guardrail_id: row.id }, 'Guardrail pattern failed to run');

    return { ...base, passed: false, matches: [], error: 'guardrail pattern could not be evaluated' };
  }
}

/**
 * Runs the organization's guardrails over the supplied content.
 *
 * Reports, it does not enforce. The response says what failed and what each
 * failing rule asked for; acting on that is the caller's business, which is
 * what lets this be used both as a pre-flight check and, later, from inside the
 * inference path.
 *
 * Deliberately unaudited. This is a read that mutates nothing, and it is meant
 * to run on every inference request - auditing it would write a row per call
 * and drown the trail it shares with api-keys.
 *
 * @param body
 * The content to check, and optionally the subset of guardrails to apply.
 *
 * @returns
 * One result per (guardrail, side) actually evaluated, plus the aggregate
 * verdict.
 */
async function evaluateGuardrails(body: EvaluateGuardrailsBody): Promise<EvaluateGuardrailsResponse> {
  const caller = getCaller();
  const conditions = [
    eq(guardrails.organization_id, caller.organization.id),
    eq(guardrails.enabled, true),
    body.guardrail_ids?.length ? inArray(guardrails.id, body.guardrail_ids) : undefined,
  ];

  // Ascending, unlike every list endpoint here: this is not a page, and results
  // read better in the order the guardrails were created.
  const rows = await db
    .select()
    .from(guardrails)
    .where(and(...conditions))
    .orderBy(asc(guardrails.id));

  const results: EvaluationResult[] = [];

  for (const row of rows) {
    for (const side of sidesFor(row.target)) {
      const content = side === 'request' ? body.request : body.response;

      // The caller did not supply this side. Not a failure - a guardrail
      // targeting the response has nothing to say about a request-only check.
      if (content === undefined) {
        continue;
      }

      switch (row.type) {
        case 'regex':
          results.push(evaluateOne(row, side, content));
          break;

        // Unreachable while 'regex' is the only member, and kept anyway: the
        // column is text, so a row can hold a type this build does not know.
        // Failing loudly beats passing content no rule was actually run over.
        default:
          getLogger().error({ guardrail_id: row.id, type: row.type }, 'Unknown guardrail type');

          results.push({
            guardrail_id: row.id,
            name: row.name,
            type: row.type,
            target: side,
            action: row.action,
            passed: false,
            matches: [],
            error: `unsupported guardrail type '${row.type}'`,
          });
          break;
      }
    }
  }

  const failed = results.filter((result) => !result.passed);

  // 'block' outranks 'flag': if any rule wants the exchange stopped, that is
  // the answer, however many others only wanted it noted.
  const action = failed.some((result) => result.action === 'block')
    ? ('block' as const)
    : failed.length > 0
      ? ('flag' as const)
      : null;

  const parsed = Schemas.evaluateGuardrails.response.parse({
    passed: failed.length === 0,
    action: action,
    results: results,
  });

  return parsed;
}

//---

/**
 * Retrieves a single guardrail by its ID, of any type.
 *
 * @param id
 * The ID of the guardrail to retrieve.
 */
async function getGuardrail(id: string): Promise<Result<GetGuardrailResponse, GetGuardrailFailure>> {
  const caller = getCaller();
  const [row] = await db
    .select()
    .from(guardrails)
    .where(and(eq(guardrails.organization_id, caller.organization.id), eq(guardrails.id, id)));

  if (!row) {
    return err({ code: 'GUARDRAIL_NOT_FOUND', id });
  }

  const parsed = Schemas.getGuardrail.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a list of guardrails, filtered by the given criteria.
 *
 * Results are returned newest-first.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listGuardrails(query: ListGuardrailsQuery): Promise<ListGuardrailsResponse> {
  const caller = getCaller();
  const conditions = [
    eq(guardrails.organization_id, caller.organization.id),
    query.after_id !== undefined ? lt(guardrails.id, query.after_id) : undefined,
    query.type !== undefined ? eq(guardrails.type, query.type) : undefined,
    query.enabled !== undefined ? eq(guardrails.enabled, query.enabled) : undefined,
  ];

  const rows = await db
    .select()
    .from(guardrails)
    .where(and(...conditions))
    .orderBy(desc(guardrails.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);
  const parsed = Schemas.listGuardrails.response.parse(page);

  return parsed;
}

/**
 * Creates a regex guardrail.
 *
 * `type` is set here rather than taken from the body - the route is what
 * decides it, which is the whole reason the config could be validated against a
 * concrete schema on the way in.
 *
 * @param body
 * The validated request body.
 */
async function createRegexGuardrail(body: CreateRegexGuardrailBody): Promise<CreateRegexGuardrailResponse> {
  const caller = getCaller();

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(guardrails)
      .values({
        ...body,
        type: 'regex',
        organization_id: caller.organization.id,
        creator_id: getAccountableUserId(caller),
      })
      .returning();

    if (!row) {
      // Probably impossible: a returning() insert either throws or gives a row.
      throw new Error('Failed to insert guardrail');
    }

    await AuditLogServices.createAuditLog(
      caller,
      {
        event: 'guardrails.created',
        target_type: 'guardrail',
        target_id: row.id,
        status: 'success',
        metadata: { name: row.name, type: row.type, target: row.target, action: row.action },
      },
      tx,
    );

    return row;
  });

  const parsed = Schemas.createRegexGuardrail.response.parse(result);
  return parsed;
}

/**
 * Updates a regex guardrail.
 *
 * The field-level before/after difference is written to the audit log in the
 * same transaction, matching updateApiKey.
 *
 * @param id
 * The ID of the guardrail to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 */
async function updateRegexGuardrail(
  id: string,
  body: UpdateRegexGuardrailBody,
): Promise<Result<UpdateRegexGuardrailResponse, UpdateRegexGuardrailFailure>> {
  const caller = getCaller();

  // The transaction resolves with a Result rather than throwing the refusal: a
  // missing row is an answer, and rolling back a read-only block to deliver one
  // would be theatre. Everything below that throws is a malfunction, and those
  // still take the transaction down with them.
  const result = await db.transaction(async (tx): Promise<Result<GuardrailRow, UpdateRegexGuardrailFailure>> => {
    const [existing] = await tx
      .select()
      .from(guardrails)
      .where(and(eq(guardrails.organization_id, caller.organization.id), eq(guardrails.id, id)))
      .for('update');

    if (!existing) {
      return err({ code: 'GUARDRAIL_NOT_FOUND', id });
    }

    // The path said regex, so the row has to be one. The same refusal as a
    // missing row rather than a distinct one: /guardrails/regex/:id addresses
    // regex guardrails, and this id is not one of them. A separate code would
    // confirm that the id exists as something else, which the caller has not
    // asked about - and the handler would have to be careful never to let
    // that difference reach the wire.
    if (existing.type !== 'regex') {
      return err({ code: 'GUARDRAIL_NOT_FOUND', id });
    }

    const writeableFields = Object.keys(Schemas.updateRegexGuardrail.body.shape);
    const { updates, difference } = diffFields(existing, body, writeableFields);

    if (Object.keys(difference).length === 0) {
      return ok(existing);
    }

    const [row] = await tx
      .update(guardrails)
      .set(updates)
      .where(and(eq(guardrails.organization_id, caller.organization.id), eq(guardrails.id, id)))
      .returning();

    if (!row) {
      throw new Error('Failed to update guardrail');
    }

    await AuditLogServices.createAuditLog(
      caller,
      {
        event: 'guardrails.updated',
        target_type: 'guardrail',
        target_id: row.id,
        status: 'success',
        difference: difference,
      },
      tx,
    );

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.updateRegexGuardrail.response.parse(result.value);
  return ok(parsed);
}

/**
 * Deletes a guardrail, of any type.
 *
 * Hard-deleted, unlike an API key. A revoked key still has to explain historical
 * usage attributed to it; a deleted guardrail explains nothing, because what it
 * did while it existed lives in the audit trail and in the logs of the requests
 * it ran against.
 *
 * @param id
 * The ID of the guardrail to delete.
 */
async function deleteGuardrail(id: string): Promise<Result<DeleteGuardrailResponse, DeleteGuardrailFailure>> {
  const caller = getCaller();

  return db.transaction(async (tx): Promise<Result<DeleteGuardrailResponse, DeleteGuardrailFailure>> => {
    const [row] = await tx
      .delete(guardrails)
      .where(and(eq(guardrails.organization_id, caller.organization.id), eq(guardrails.id, id)))
      .returning();

    if (!row) {
      return err({ code: 'GUARDRAIL_NOT_FOUND', id });
    }

    await AuditLogServices.createAuditLog(
      caller,
      {
        event: 'guardrails.deleted',
        target_type: 'guardrail',
        target_id: row.id,
        status: 'success',

        // The row is gone, so the audit entry is the only remaining record of
        // what was being enforced. Stated rather than diffed for that reason.
        metadata: {
          name: row.name,
          type: row.type,
          target: row.target,
          action: row.action,
          config: row.config,
        },
      },
      tx,
    );

    return ok(undefined);
  });
}

export default {
  evaluateGuardrails,

  getGuardrail,
  listGuardrails,
  createRegexGuardrail,
  updateRegexGuardrail,
  deleteGuardrail,
};
