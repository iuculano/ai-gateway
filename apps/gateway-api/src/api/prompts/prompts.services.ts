import { and, db, eq, lt, sql } from '@lib/drizzle';
import Schemas, {
  type CreatePromptBody,
  type CreatePromptResponse,
  type DeletePromptResponse,
  type GetPromptResponse,
  type ListPromptsBody,
  type ListPromptsQuery,
  type ListPromptsResponse,
  type UpdatePromptBody,
  type UpdatePromptResponse,
} from './prompts.schemas';
import { prompts } from '@db/schemas/prompts';
import { HTTPException } from 'hono/http-exception';
import { parseTags } from '@lib/utils';


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

  const parsed = Schemas.getPromptResponse.parse(result[0]);
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

  const parsed = Schemas.getPromptResponse.parse(result[0]);
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

  const parsed = Schemas.listPromptsResponse.parse({
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

  const parsed = Schemas.createPromptResponse.parse(result[0]);
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

  const parsed = Schemas.updatePromptResponse.parse(result[0]);
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
 * Retrieves a single prompt by its ID.
 *
 * @param id
 * The ID of the prompt to retrieve.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function getPromptVersion(version: number) : Promise<GetPromptResponse> {
  const result = await db.select()
    .from(prompts)
    .where(eq(prompts.id, id));

  if (!result[0]) {
    throw new HTTPException(404);
  }

  const parsed = Schemas.getPromptResponse.parse(result[0]);
  return parsed;
}

function renderSubstitution(substitution: string) : string | undefined {
  //
  if (!substitution) {
    throw new HTTPException(500, {
      message: 'This should be impossible, tell an adult',
    });
  }

  // Check if this is an built-in substitution.
  const prefix = substitution.split('.')[0];
  if (prefix === 'aig') {
    switch (substitution) {
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


function createSubstitutions(prompt: string, inputs: Record<string, string>) : Record<string, string> {
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
    const substitution = renderSubstitution(variable);
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
function renderPrompt(prompt: string, inputs: Record<string, string>) : string {
  const substitutions = createSubstitutions(prompt, inputs);

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
  renderPrompt,
}
