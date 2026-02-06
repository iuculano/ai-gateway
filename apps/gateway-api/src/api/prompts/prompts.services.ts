import { and, db, eq, lt, sql } from '@lib/drizzle';
import Schemas, {
  type CreatePromptRequest,
  type CreatePromptResponse,
  type DeletePromptResponse,
  type GetPromptResponse,
  type ListPromptsRequest,
  type ListPromptsResponse,
  type UpdatePromptRequest,
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
 * @param request
 * The request object containing the filter criteria.
 *
 * @returns
 * A promise that resolves to the prompt data.
 */
async function listPrompts(request: ListPromptsRequest) : Promise<ListPromptsResponse> {
  const tagsToFilter = parseTags(request.tags);

  const conditions = [
    request.tags      ? sql`${prompts.tags} @> ${tagsToFilter}::jsonb` : undefined,
    request.after_id  ? lt(prompts.id, request.after_id) : undefined,
  ];

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const result = await db.select()
    .from(prompts)
    .where(whereClause)
    .limit(request.limit + 1); // Fetch one extra to determine if there's more.

  const hasMoreData = result.length > request.limit;
  if (hasMoreData) {
    // Burn off the extra record.
    result.pop();
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
 * Creates a new log entry in the database.
 *
 * @param request
 * The request object containing the log data to be created.
 *
 * @returns
 * A promise that resolves to the created log data.
 */
async function createPrompt(request: CreatePromptRequest) : Promise<CreatePromptResponse> {
  const result = await db.insert(prompts)
    .values(request)
    .returning();

  const parsed = Schemas.createPromptResponse.parse(result[0]);
  return parsed;
}

/**
 * Updates an existing log entry in the database.
 *
 * @param id
 * The ID of the log to update.
 *
 * @param payload
 * The update payload containing the fields to be updated.
 *
 * @returns
 * A promise that resolves to the updated log data.
 */
async function updatePrompt(id: string, payload: UpdatePromptRequest) : Promise<UpdatePromptResponse> {
  const result = await db.update(prompts)
    .set(payload)
    .where(eq(prompts.id, id))
    .returning();

  const parsed = Schemas.updatePromptResponse.parse(result[0]);
  return parsed;
}

async function deletePrompt(id: string) : Promise<DeletePromptResponse> {
  const result = await db.delete(prompts)
    .where(eq(prompts.id, id))
    .returning();

  if (!result[0]) {
    throw new HTTPException(404);
  }

  return null as DeletePromptResponse;
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

export default {
  getPrompt,
  getPromptByName,
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
}
