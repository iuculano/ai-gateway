import { diffFields, parseTags, probe, toPage } from '@repo/core';
import { and, db, desc, eq, lt, sql } from '@repo/drizzle';
import { type PromptRow, type PromptVersionRow, prompts, promptVersions } from '@repo/drizzle/schemas';
import { getAccountableUserId, getCaller } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import { SCOPES } from '../../authorization';
import AuditLogServices from '../audit-logs/audit-logs.services';
import { type BuiltinContext, resolveBuiltin } from './prompts.builtins';
import Schemas, {
  type CreatePromptBody,
  type CreatePromptResponse,
  type CreatePromptVersionBody,
  type CreatePromptVersionResponse,
  type DeletePromptResponse,
  type DeletePromptVersionResponse,
  type GetPromptResponse,
  type GetPromptVersionResponse,
  type ListPromptsQuery,
  type ListPromptsResponse,
  type ListPromptVersionsQuery,
  type ListPromptVersionsResponse,
  type RenderPromptVersionResponse,
  type UpdatePromptBody,
  type UpdatePromptResponse,
  type UpdatePromptVersionBody,
  type UpdatePromptVersionResponse,
} from './prompts.schemas';

/**
 * The outcomes a caller can act on.
 *
 * Declared per operation rather than shared, so a code added to one cannot
 * silently widen the others. Everything else here - a failed query, a row that
 * will not parse, an insert that returns nothing - is the system malfunctioning
 * rather than an answer, and rejects.
 *
 * A prompt belonging to another organization is PROMPT_NOT_FOUND rather than a
 * distinct code. The caller has no standing to learn that the id exists at all,
 * and a separate code would tell them.
 */
export type GetPromptFailure = {
  code: 'PROMPT_NOT_FOUND';
  id: string;
};

export type GetPromptByNameFailure = {
  code: 'PROMPT_NOT_FOUND';
  name: string;
};

export type CreatePromptFailure = {
  code: 'PROMPT_NAME_TAKEN';
  name: string;
};

export type UpdatePromptFailure =
  | { code: 'PROMPT_NOT_FOUND'; id: string }
  | { code: 'PROMPT_NAME_TAKEN'; name: string }
  | { code: 'PROMPT_VERSION_NOT_FOUND'; id: string; version: number };

export type DeletePromptFailure = {
  code: 'PROMPT_NOT_FOUND';
  id: string;
};

export type GetPromptVersionFailure = {
  code: 'PROMPT_VERSION_NOT_FOUND';
  id: string;
  version: number;
};

export type ListPromptVersionsFailure = {
  code: 'PROMPT_NOT_FOUND';
  id: string;
};

export type CreatePromptVersionFailure = {
  code: 'PROMPT_NOT_FOUND';
  id: string;
};

export type UpdatePromptVersionFailure = {
  code: 'PROMPT_VERSION_NOT_FOUND';
  id: string;
  version: number;
};

export type DeletePromptVersionFailure =
  | { code: 'PROMPT_VERSION_NOT_FOUND'; id: string; version: number }
  | { code: 'PROMPT_VERSION_ACTIVE'; id: string; version: number };

/**
 * Resolving a prompt for an inference request.
 *
 * Wider than the dashboard's render failures because the caller is naming a
 * prompt rather than addressing one it has already seen: the name may not
 * exist, the prompt may have no version to serve, and - unlike the preview -
 * a template whose variables are not all supplied is a refusal rather than a
 * partially rendered answer.
 */
export type ResolvePromptFailure =
  | { code: 'PROMPT_FORBIDDEN'; required: string }
  | { code: 'PROMPT_NOT_FOUND'; name: string }
  | { code: 'PROMPT_NO_ACTIVE_VERSION'; name: string }
  | { code: 'PROMPT_VERSION_NOT_FOUND'; name: string; version: number }
  | { code: 'PROMPT_VARIABLES_MISSING'; name: string; version: number; missing: string[] };

export type RenderPromptVersionFailure = {
  code: 'PROMPT_VERSION_NOT_FOUND';
  id: string;
  version: number;
};

/** The client, or a transaction inside one. Same shape audit-logs.services uses. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The organization predicate, in one place.
 *
 * Every read and write below goes through this rather than spelling the
 * predicate out, so "did this query carry a tenancy check" is answered by
 * whether it called this rather than by re-reading each `where`.
 */
function scopedToCaller(id: string) {
  const caller = getCaller();
  return and(eq(prompts.organization_id, caller.organization.id), eq(prompts.id, id));
}

/**
 * Loads a prompt the caller is entitled to, or nothing.
 *
 * @param executor
 * The client, or the surrounding transaction.
 *
 * @param id
 * The prompt to load.
 *
 * @param lock
 * Take a row lock, for the callers that go on to write through it.
 */
async function findPrompt(executor: DbExecutor, id: string, lock = false): Promise<PromptRow | undefined> {
  const query = executor.select().from(prompts).where(scopedToCaller(id));

  const [row] = lock ? await query.for('update') : await query;
  return row;
}

//---

/**
 * Retrieves a single prompt by its ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 */
async function getPrompt(id: string): Promise<Result<GetPromptResponse, GetPromptFailure>> {
  const row = await findPrompt(db, id);

  if (!row) {
    return err({ code: 'PROMPT_NOT_FOUND', id });
  }

  const parsed = Schemas.getPrompt.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a single prompt by its name.
 *
 * Names resolve within the caller's organization. This supports inference
 * references, which use configured names rather than database ids.
 *
 * @param name
 * The name of the prompt to retrieve.
 */
async function getPromptByName(name: string): Promise<Result<GetPromptResponse, GetPromptByNameFailure>> {
  const caller = getCaller();

  const [row] = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.organization_id, caller.organization.id), eq(prompts.name, name)));

  if (!row) {
    return err({ code: 'PROMPT_NOT_FOUND', name });
  }

  const parsed = Schemas.getPrompt.response.parse(row);
  return ok(parsed);
}

/**
 * Retrieves a list of prompts, filtered by the given criteria.
 *
 * Results are returned newest-first.
 *
 * @param query
 * The request object containing the filter criteria.
 */
async function listPrompts(query: ListPromptsQuery): Promise<ListPromptsResponse> {
  const caller = getCaller();
  const tagsToFilter = parseTags(query.tags);

  const conditions = [
    eq(prompts.organization_id, caller.organization.id),
    tagsToFilter ? sql`${prompts.tags} @> ${JSON.stringify(tagsToFilter)}::jsonb` : undefined,
    query.after_id !== undefined ? lt(prompts.id, query.after_id) : undefined,
  ];

  const rows = await db
    .select()
    .from(prompts)
    .where(and(...conditions))
    .orderBy(desc(prompts.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);
  const parsed = Schemas.listPrompts.response.parse(page);

  return parsed;
}

/**
 * Creates a new prompt.
 *
 * The prompt is created without any versions - `active_version` is null until
 * a version exists to point at, which is why the create body cannot set it.
 *
 * @param body
 * The validated request body.
 */
async function createPrompt(body: CreatePromptBody): Promise<Result<CreatePromptResponse, CreatePromptFailure>> {
  const caller = getCaller();

  const result = await db.transaction(async (tx): Promise<Result<PromptRow, CreatePromptFailure>> => {
    // Let the unique index arbitrate concurrent creates so both name conflicts
    // return the same refusal.
    const [row] = await tx
      .insert(prompts)
      .values({
        ...body,
        organization_id: caller.organization.id,
        creator_id: getAccountableUserId(caller),
      })
      .onConflictDoNothing({ target: [prompts.organization_id, prompts.name] })
      .returning();

    if (!row) {
      return err({ code: 'PROMPT_NAME_TAKEN', name: body.name });
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.created',
        target_type: 'prompt',
        target_id: row.id,
        status: 'success',
        metadata: { name: row.name, description: row.description, tags: row.tags },
      },
      tx,
    );

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.createPrompt.response.parse(result.value);
  return ok(parsed);
}

/**
 * Updates an existing prompt.
 *
 * The field-level before/after difference is written to the audit log in the
 * same transaction, matching updateApiKey.
 *
 * @param id
 * The ID of the prompt to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 */
async function updatePrompt(
  id: string,
  body: UpdatePromptBody,
): Promise<Result<UpdatePromptResponse, UpdatePromptFailure>> {
  // Expected refusals use Result; thrown failures still roll back the transaction.
  const result = await db.transaction(async (tx): Promise<Result<PromptRow, UpdatePromptFailure>> => {
    const existing = await findPrompt(tx, id, true);

    if (!existing) {
      return err({ code: 'PROMPT_NOT_FOUND', id });
    }

    // active_version stores an ordinal rather than a foreign key, so validate it here.
    if (body.active_version !== undefined && body.active_version !== null) {
      const [version] = await tx
        .select({ version: promptVersions.version })
        .from(promptVersions)
        .where(and(eq(promptVersions.prompt_id, id), eq(promptVersions.version, body.active_version)));

      if (!version) {
        return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version: body.active_version });
      }
    }

    const writeableFields = Object.keys(Schemas.updatePrompt.body.shape);
    const { updates, difference } = diffFields(existing, body, writeableFields);

    if (Object.keys(difference).length === 0) {
      return ok(existing);
    }

    // Give ordinary name conflicts a 409; the unique index handles concurrent races.
    const nextName = body.name;

    if (nextName !== undefined && difference.name !== undefined) {
      const caller = getCaller();

      const [conflict] = await tx
        .select({ id: prompts.id })
        .from(prompts)
        .where(and(eq(prompts.organization_id, caller.organization.id), eq(prompts.name, nextName)));

      if (conflict) {
        return err({ code: 'PROMPT_NAME_TAKEN', name: nextName });
      }
    }

    const [row] = await tx.update(prompts).set(updates).where(scopedToCaller(id)).returning();

    if (!row) {
      throw new Error('Failed to update prompt');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.updated',
        target_type: 'prompt',
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

  const parsed = Schemas.updatePrompt.response.parse(result.value);
  return ok(parsed);
}

/**
 * Deletes an existing prompt, and every version under it.
 *
 * Hard-deleted, and the versions go with it through the cascade on
 * prompt_versions.prompt_id. What the prompt said while it existed is
 * recoverable from the audit trail and from the logs of the requests it was
 * rendered into, which is what makes the row itself disposable.
 *
 * @param id
 * The ID of the prompt to delete.
 */
async function deletePrompt(id: string): Promise<Result<DeletePromptResponse, DeletePromptFailure>> {
  return db.transaction(async (tx): Promise<Result<DeletePromptResponse, DeletePromptFailure>> => {
    const [row] = await tx.delete(prompts).where(scopedToCaller(id)).returning();

    if (!row) {
      return err({ code: 'PROMPT_NOT_FOUND', id });
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.deleted',
        target_type: 'prompt',
        target_id: row.id,
        status: 'success',

        // The row is gone, so the audit entry is the only remaining record of
        // what was deleted. Stated rather than diffed for that reason.
        metadata: {
          name: row.name,
          description: row.description,
          active_version: row.active_version,
          tags: row.tags,
        },
      },
      tx,
    );

    return ok(undefined);
  });
}

//---

/**
 * Retrieves a single version of a prompt.
 *
 * The parent join enforces tenancy because prompt versions have no
 * `organization_id` of their own.
 *
 * @param id
 * The ID of the parent prompt.
 *
 * @param version
 * The version ordinal to retrieve.
 */
async function getPromptVersion(
  id: string,
  version: number,
): Promise<Result<GetPromptVersionResponse, GetPromptVersionFailure>> {
  const [row] = await db
    .select({ version: promptVersions })
    .from(promptVersions)
    .innerJoin(prompts, eq(prompts.id, promptVersions.prompt_id))
    .where(and(scopedToCaller(id), eq(promptVersions.version, version)));

  if (!row) {
    return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
  }

  const parsed = Schemas.getPromptVersion.response.parse(row.version);
  return ok(parsed);
}

/**
 * Retrieves a list of versions for a given prompt.
 *
 * Results are returned newest-first.
 *
 * @param id
 * The ID of the parent prompt.
 *
 * @param query
 * The filter criteria for pagination.
 */
async function listPromptVersions(
  id: string,
  query: ListPromptVersionsQuery,
): Promise<Result<ListPromptVersionsResponse, ListPromptVersionsFailure>> {
  // Resolve the parent first so a missing prompt is not mistaken for an empty page.
  const prompt = await findPrompt(db, id);

  if (!prompt) {
    return err({ code: 'PROMPT_NOT_FOUND', id });
  }

  const conditions = [
    eq(promptVersions.prompt_id, id),
    query.after_id !== undefined ? lt(promptVersions.id, query.after_id) : undefined,
  ];

  // Avoid loading prompt bodies that the version listing does not return.
  const rows = await db
    .select({
      id: promptVersions.id,
      prompt_id: promptVersions.prompt_id,
      version: promptVersions.version,
      created_at: promptVersions.created_at,
      updated_at: promptVersions.updated_at,
    })
    .from(promptVersions)
    .where(and(...conditions))
    .orderBy(desc(promptVersions.id))
    .limit(probe(query.limit));

  const page = toPage(rows, query.limit);
  const parsed = Schemas.listPromptVersions.response.parse(page);

  return ok(parsed);
}

/**
 * Creates a new version of a prompt.
 *
 * @param id
 * The ID of the parent prompt for which to create a new version.
 *
 * @param body
 * The validated request body.
 */
async function createPromptVersion(
  id: string,
  body: CreatePromptVersionBody,
): Promise<Result<CreatePromptVersionResponse, CreatePromptVersionFailure>> {
  // Version allocation must be serialized per prompt.
  const result = await db.transaction(async (tx): Promise<Result<PromptVersionRow, CreatePromptVersionFailure>> => {
    // Lock the tenant-scoped parent before deriving the next version.
    const prompt = await findPrompt(tx, id, true);

    if (!prompt) {
      return err({ code: 'PROMPT_NOT_FOUND', id });
    }

    const [row] = await tx
      .insert(promptVersions)
      .values({
        prompt_id: id,
        prompt: body.prompt,

        version: sql`
          (
            SELECT COALESCE(MAX(${promptVersions.version}), 0) + 1
            FROM ${promptVersions}
            WHERE ${promptVersions.prompt_id} = ${id}
          )
        `,
      })
      .returning();

    if (!row) {
      throw new Error('Failed to insert prompt version');
    }

    // Make the first version usable immediately, later promotion stays
    // explicit.
    if (prompt.active_version === null) {
      await tx.update(prompts).set({ active_version: row.version }).where(scopedToCaller(id));
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.versions.created',
        target_type: 'prompt',
        target_id: id,
        status: 'success',
        metadata: { version: row.version, activated: prompt.active_version === null },
      },
      tx,
    );

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.createPromptVersion.response.parse(result.value);
  return ok(parsed);
}

/**
 * Updates an existing version of a prompt.
 *
 * @param id
 * The ID of the parent prompt.
 *
 * @param version
 * The version ordinal to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 */
async function updatePromptVersion(
  id: string,
  version: number,
  body: UpdatePromptVersionBody,
): Promise<Result<UpdatePromptVersionResponse, UpdatePromptVersionFailure>> {
  const result = await db.transaction(async (tx): Promise<Result<PromptVersionRow, UpdatePromptVersionFailure>> => {
    // The parent is what carries the organization, so it is resolved first and
    // the version is addressed underneath it.
    const prompt = await findPrompt(tx, id);

    if (!prompt) {
      return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
    }

    const [existing] = await tx
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.prompt_id, id), eq(promptVersions.version, version)))
      .for('update');

    if (!existing) {
      return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
    }

    const writeableFields = Object.keys(Schemas.updatePromptVersion.body.shape);
    const { updates, difference } = diffFields(existing, body, writeableFields);

    if (Object.keys(difference).length === 0) {
      return ok(existing);
    }

    const [row] = await tx
      .update(promptVersions)
      .set(updates)
      .where(and(eq(promptVersions.prompt_id, id), eq(promptVersions.version, version)))
      .returning();

    if (!row) {
      throw new Error('Failed to update prompt version');
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.versions.updated',
        target_type: 'prompt',
        target_id: id,
        status: 'success',
        difference: difference,
        metadata: { version: version },
      },
      tx,
    );

    return ok(row);
  });

  if (result.isErr()) {
    return err(result.error);
  }

  const parsed = Schemas.updatePromptVersion.response.parse(result.value);
  return ok(parsed);
}

/**
 * Deletes a single version of a prompt.
 *
 * @param id
 * The ID of the parent prompt.
 *
 * @param version
 * The version ordinal to delete.
 */
async function deletePromptVersion(
  id: string,
  version: number,
): Promise<Result<DeletePromptVersionResponse, DeletePromptVersionFailure>> {
  return db.transaction(async (tx): Promise<Result<DeletePromptVersionResponse, DeletePromptVersionFailure>> => {
    const prompt = await findPrompt(tx, id, true);

    if (!prompt) {
      return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
    }

    // Require the caller to choose a replacement before deleting the active
    // version.
    if (prompt.active_version === version) {
      return err({ code: 'PROMPT_VERSION_ACTIVE', id, version });
    }

    const [row] = await tx
      .delete(promptVersions)
      .where(and(eq(promptVersions.prompt_id, id), eq(promptVersions.version, version)))
      .returning();

    if (!row) {
      return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
    }

    await AuditLogServices.createAuditLog(
      {
        event: 'prompts.versions.deleted',
        target_type: 'prompt',
        target_id: id,
        status: 'success',

        // The row is gone, so this is the only remaining record of what the
        // version actually said.
        metadata: { version: row.version, prompt: row.prompt },
      },
      tx,
    );

    return ok(undefined);
  });
}

//---

/**
 * The mustache tags this renderer recognises.
 *
 * Inner whitespace is optional. Matching remains case-sensitive because input
 * names and the `aig.` namespace are case-sensitive.
 */
const SUBSTITUTION_PATTERN = /\{\{\s*([A-Za-z0-9._-]+)\s*\}\}/g;

/**
 * Renders a prompt, replacing mustache tags with their values.
 *
 * Built-ins take precedence over caller inputs. Missing values remain visible
 * and are reported as unresolved; a single pass prevents substituted values
 * from introducing new built-in references.
 *
 * @param prompt
 * The prompt template to render.
 *
 * @param inputs
 * Caller-supplied values, keyed by tag name.
 *
 * @param context
 * Shared built-in context so every tag in one render sees the same instant.
 */
function renderTemplate(
  prompt: string,
  inputs: Record<string, string>,
  context: BuiltinContext,
): RenderPromptVersionResponse {
  const unresolved = new Set<string>();

  const rendered = prompt.replace(SUBSTITUTION_PATTERN, (match, variable: string) => {
    // Exclude inherited properties such as `constructor` from prompt inputs.
    const supplied = Object.hasOwn(inputs, variable) ? inputs[variable] : undefined;
    const value = resolveBuiltin(variable, context) ?? supplied;

    if (value === undefined) {
      unresolved.add(variable);
      return match;
    }

    return value;
  });

  const parsed = Schemas.renderPromptVersion.response.parse({
    prompt: rendered,
    unresolved: [...unresolved],
  });

  return parsed;
}

/**
 * Renders a stored prompt version with the supplied inputs.
 *
 * @param id
 * The ID of the parent prompt.
 *
 * @param version
 * The version ordinal to render.
 *
 * @param inputs
 * Caller-supplied values, keyed by tag name.
 */
async function renderPromptVersion(
  id: string,
  version: number,
  inputs: Record<string, string>,
): Promise<Result<RenderPromptVersionResponse, RenderPromptVersionFailure>> {
  const caller = getCaller();

  // The same tenant-scoped join supplies both the template and its name for built-ins.
  const [row] = await db
    .select({ template: promptVersions.prompt, name: prompts.name })
    .from(promptVersions)
    .innerJoin(prompts, eq(prompts.id, promptVersions.prompt_id))
    .where(and(scopedToCaller(id), eq(promptVersions.version, version)));

  if (!row) {
    return err({ code: 'PROMPT_VERSION_NOT_FOUND', id, version });
  }

  // Assembled once, so every tag in this render sees the same instant - two
  // clock built-ins in one template cannot disagree about what time it is.
  const context: BuiltinContext = {
    now: new Date(),
    organization: caller.organization,
    prompt: { name: row.name, version: version },
    requestId: caller.request.id,
  };

  return ok(renderTemplate(row.template, inputs, context));
}

/**
 * Resolves a prompt by name and renders it for an inference request.
 *
 * Inference rendering is strict: unresolved tags fail instead of being sent to
 * the provider. The prompt scope is checked here because only inference
 * requests that reference a prompt require it.
 *
 * @param reference
 * The prompt name, the version to pin (or none, for the active one), and the
 * values for its variables.
 */
async function resolvePrompt(reference: {
  name: string;
  version?: number | null;
  variables?: Record<string, string> | null;
}): Promise<Result<{ version: number; prompt: string }, ResolvePromptFailure>> {
  const caller = getCaller();

  if (!caller.permissions.scopes.includes(SCOPES.promptsRead)) {
    return err({ code: 'PROMPT_FORBIDDEN', required: SCOPES.promptsRead });
  }

  const [prompt] = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.organization_id, caller.organization.id), eq(prompts.name, reference.name)));

  if (!prompt) {
    return err({ code: 'PROMPT_NOT_FOUND', name: reference.name });
  }

  // Keep missing pinned versions distinct from prompts with no active version.
  const version = reference.version ?? prompt.active_version;

  if (version == null) {
    return err({ code: 'PROMPT_NO_ACTIVE_VERSION', name: reference.name });
  }

  const [row] = await db
    .select({ template: promptVersions.prompt })
    .from(promptVersions)
    .where(and(eq(promptVersions.prompt_id, prompt.id), eq(promptVersions.version, version)));

  if (!row) {
    return err({ code: 'PROMPT_VERSION_NOT_FOUND', name: reference.name, version });
  }

  const context: BuiltinContext = {
    now: new Date(),
    organization: caller.organization,
    prompt: { name: prompt.name, version: version },
    requestId: caller.request.id,
  };

  const rendered = renderTemplate(row.template, reference.variables ?? {}, context);

  if (rendered.unresolved.length > 0) {
    return err({
      code: 'PROMPT_VARIABLES_MISSING',
      name: reference.name,
      version: version,
      missing: rendered.unresolved,
    });
  }

  return ok({ version: version, prompt: rendered.prompt });
}

export default {
  getPrompt,
  getPromptByName,
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,

  getPromptVersion,
  listPromptVersions,
  createPromptVersion,
  updatePromptVersion,
  deletePromptVersion,
  renderPromptVersion,
  resolvePrompt,
};
