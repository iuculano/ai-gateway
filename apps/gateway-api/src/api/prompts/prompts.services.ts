import { HTTPException } from 'hono/http-exception';
import { and, db, eq, lt, sql } from '@lib/drizzle';
import { parseTags } from '@lib/utils';
import { prompts, promptVersions } from '@db/schemas/prompts';
import Schemas, {
  type CreatePromptBody,
  type CreatePromptResponse,
  type CreatePromptVersionBody,
  type CreatePromptVersionResponse,
  type DeletePromptResponse,
  type GetPromptResponse,
  type GetPromptVersionResponse,
  type ListPromptsQuery,
  type ListPromptsResponse,
  type ListPromptVersionsQuery,
  type ListPromptVersionsResponse,
  type UpdatePromptBody,
  type UpdatePromptResponse,
  type UpdatePromptVersionBody,
  type UpdatePromptVersionResponse,
} from './prompts.schemas';

/**
 * Retrieves a single prompt by its ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function getPrompt(id: string) : Promise<GetPromptResponse> {
  const result = await db.select()
    .from(prompts)
    .where(eq(prompts.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getPrompt.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a single prompt by its name.
 *
 * @param name
 * The name of the prompt to retrieve.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function getPromptByName(name: string) : Promise<GetPromptResponse> {
  const result = await db.select()
    .from(prompts)
    .where(eq(prompts.name, name));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getPrompt.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a list of prompts, filtered by the given criteria.
 *
 * @param query
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function listPrompts(query: ListPromptsQuery) : Promise<ListPromptsResponse> {
  const tagsToFilter = parseTags(query.tags);

  const conditions = [
    query.tags      ? sql`${prompts.tags} @> ${tagsToFilter}::jsonb` : undefined,
    query.after_id  ? lt(prompts.id, query.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(prompts)
    .where(whereClause)
    .limit(query.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > query.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listPrompts.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new prompt entry in the database.
 *
 * @param body
 * The request object containing the prompt data to be created.
 *
 * @returns
 * A promise that resolves to the created prompt data.
 */
async function createPrompt(body: CreatePromptBody) : Promise<CreatePromptResponse> {
  const result = await db.insert(prompts)
    .values(body)
    .returning();

  const parsed = Schemas.createPrompt.response.parse({
    ...result[0],
    active_version: null
  });
  return parsed;
}

/**
 * Updates an existing prompt entry in the database.
 *
 * @param id
 * The ID of the prompt to update.
 *
 * @param body
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated prompt data.
 */
async function updatePrompt(id: string, body: UpdatePromptBody) : Promise<UpdatePromptResponse> {
  const result = await db.update(prompts)
    .set(body)
    .where(eq(prompts.id, id))
    .returning();

  const parsed = Schemas.updatePrompt.response.parse(result[0]);
  return parsed;
}

/**
 * Deletes an existing prompt entry in the database.
 *
 * @param id
 * The ID of the prompt to delete.
 *
 * @returns
 * Nothing.
 */
async function deletePrompt(id: string) : Promise<DeletePromptResponse> {
  const result = await db.delete(prompts)
    .where(eq(prompts.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }
}

/**
 * Retrieves a single prompt version by its ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function getPromptVersion(id: string, version: number) : Promise<GetPromptVersionResponse> {
  const result = await db.select()
    .from(promptVersions)
    .where(and(
      eq(promptVersions.prompt_id, id),
      eq(promptVersions.version, version),
    ));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getPromptVersion.response.parse(result[0]);
  return parsed;
}

/**
 * Retrieves a list of prompt versions for a given prompt ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 * 
 * @param query
 * The filter criteria for pagination, etc.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function listPromptVersions(id: string, query: ListPromptVersionsQuery) : Promise<ListPromptVersionsResponse> {
  const conditions = [
    query.after_id ? lt(promptVersions.id, query.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(promptVersions)
    .where(whereClause)
    .limit(query.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > query.limit;
  if (hasMoreData) {
    result.pop(); // Burn off the extra record.
  }

  const oldestId = result[result.length - 1]?.id ?? null;

  const parsed = Schemas.listPromptVersions.response.parse({
    data: result,
    meta: {
      oldest_id: oldestId,
      more_data: hasMoreData,
    },
  });

  return parsed;
}

/**
 * Creates a new prompt version.
 * 
 * @param id
 * The ID of the parent prompt for which to create a new version.
 *
 * @param body
 * The request object containing the prompt version data to be created.
 *
 * @returns
 * A promise that resolves to the created prompt data.
 */
async function createPromptVersion(id: string, body: CreatePromptVersionBody) : Promise<CreatePromptVersionResponse> {

  // Needs to be atomic since we have to compute the next version number based
  // on existing versions for this prompt.
  const parsed = await db.transaction(async (tx) => {

    // Lock the parent prompt row to prevent concurrent version creation which
    // could result in duplicate/wrong version numbers.
    //
    // That is, as long as every "create version" ransaction takes that same
    // parent-row lock first, inserts into prompt_versions for that prompt_id
    // will effectively serialize per prompt.
    await tx.execute(sql`
      SELECT 1
      FROM ${prompts}
      WHERE ${prompts.id} = ${id}
      FOR UPDATE
    `);

    // Insert with computed next version (per prompt_id)
    const result = await tx.insert(promptVersions)
      .values({
        prompt_id: id,
        prompt: body.prompt,

        // next version = max(version) + 1 for this prompt
        version: sql`
        (
          SELECT COALESCE(MAX(${promptVersions.version}), 0) + 1
          FROM ${promptVersions}
          WHERE ${promptVersions.prompt_id} = ${id}
        )
        `,
      })
      .returning();

    return Schemas.createPromptVersion.response.parse(result[0]);
  });

  return parsed;
}

async function updatePromptVersion(id: string, version: number, body: UpdatePromptVersionBody) : Promise<UpdatePromptVersionResponse> {
  const result = await db.update(promptVersions)
    .set(body)
    .where(and(
      eq(promptVersions.prompt_id, id),
      eq(promptVersions.version, version),
    ))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.updatePromptVersion.response.parse(result[0]);
  return parsed;
}

async function deletePromptVersion(id: string, version: number) : Promise<void> {
  const result = await db.delete(promptVersions)
    .where(and(
      eq(promptVersions.prompt_id, id),
      eq(promptVersions.version, version),
    ))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }
}

/**
 * Tries to render a built-in substitution or user defined variable.
 *
 * If the the subtitution string matches a built-in substitution pattern, e.g.
 * "aig.date", it will render the corresponding value.
 *
 * @param substitution The substitution string to evaluate, e.g. "aig.date".
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
function tryRenderInternalSubstitution(substitution: string) : string | undefined {
  //
  if (!substitution) {
    throw new HTTPException(500, {
      message: 'This should be impossible, tell an adult',
    });
  }

  // Check if this is an built-in substitution.
  const [prefix, value] = substitution.split('.');
  if (prefix === 'aig' && (prefix && value)) {
    switch (value) {
      case 'date':
        return new Date().toISOString().split('T')[0] as string;

      case 'time':
        return ((new Date().toISOString().split('T')[1] as string).split('.')[0]) as string;

      case 'datetime':
        return new Date().toISOString();
    };
  }

  // User defined variable.
  if (substitution.startsWith('var')) {
    return 'test';
  }

  // Not an internal substitution, value is possibly coming from user input.
  return undefined;
}

/**
 * 
 *
 * @param prompt The prompt string to render.
 *
 * @param inputs A record of input values to substitute into the prompt.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
function createSubstitutionsMap(prompt: string, inputs: Record<string, string>) : Record<string, string> {
  const substitutions: Record<string, string> = {};

  const pattern = /{{\s+([a-z0-9.-]+)\s+}}/g;
  for (const match of prompt.matchAll(pattern)) {
    // This is the capture - the value inside the mustache tags, e.g.
    // "aig.date" or "var.service-name"
    const variable = match[1];
    if (!variable) {
      continue;
    }

    // Handle built-in substitutions and user defined variables.
    const substitution = tryRenderInternalSubstitution(variable);
    if (substitution) {
      substitutions[variable] = substitution;
    }

    // If it wasn't built-in or user defined, try to find it in the body as
    // inputs.
    if (inputs[variable]) {
      substitutions[variable] = inputs[variable];
    }
  }

  return substitutions;
}

/**
 * Renders a prompt, replacing valid mustache tags with their corresponding
 * values from built-in substitutions, user defined variables, or the provided
 * input values.
 *
 * @param prompt The prompt string to render.
 *
 * @param inputs A record of input values to substitute into the prompt.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function renderPromptVersion(prompt: string, inputs: Record<string, string>) : Promise<string> {
  const substitutions = createSubstitutionsMap(prompt, inputs);

  let rendered = prompt;
  for (const [key, value] of Object.entries(substitutions)) {
    rendered = rendered.replace(`{{ ${key} }}`, value);
  }

  return rendered;
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
}
