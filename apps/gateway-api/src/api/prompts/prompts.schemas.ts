import { z } from '@hono/zod-openapi';


const promptShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  tags: z.record(z.string(), z.unknown()).optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPromptRequest = z.object({
  id: z.uuidv7(),
});

const getPromptResponse = promptShape;

const listPromptsRequest = z.object({
  tags: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional().default(25),
  after_id: z.uuidv7().optional(),
});

const listPromptsResponse = z.object({
  data: z.array(promptShape),
  meta: z.object({
    oldest_id: z.uuidv7().nullable(),
    more_data: z.boolean()
  })
});

const createPromptRequest = promptShape.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

const createPromptResponse = promptShape;

const updatePromptRequest = promptShape.partial().omit({
  id: true,         // ID is not updated
  created_at: true, // Created at is not updated;
  updated_at: true, // Updated automatically
});

const updatePromptResponse = promptShape;

const deletePromptRequest = z.object({
  id: z.uuidv7(),
});

const deletePromptResponse = z.never();


export type GetPromptResponse = z.infer<typeof getPromptResponse>;
export type GetPromptRequest = z.infer<typeof getPromptRequest>;
export type ListPromptsRequest = z.infer<typeof listPromptsRequest>;
export type ListPromptsResponse = z.infer<typeof listPromptsResponse>;
export type CreatePromptRequest = z.infer<typeof createPromptRequest>;
export type CreatePromptResponse = z.infer<typeof createPromptResponse>;
export type UpdatePromptRequest =  z.infer<typeof updatePromptRequest>;
export type UpdatePromptResponse = z.infer<typeof updatePromptResponse>;
export type DeletePromptRequest = z.infer<typeof deletePromptRequest>;
export type DeletePromptResponse = z.infer<typeof deletePromptResponse>;

const promptVersionShape = z.object({
  id: z.uuidv7(),
  prompt_id: z.uuidv7(),
  prompt: z.string(),
  version: z.number().int(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPromptVersionRequest = z.object({
  version: z.number().int(),
});

const getPromptVersionResponse = promptVersionShape;

const listPromptVersionsRequest = z.object({
  limit: z.coerce.number().int().min(1).max(250).optional().default(25),
  after_id: z.uuidv7().optional(),
});

const listPromptVersionsResponse = z.object({
  data: z.array(promptVersionShape.omit({
    prompt: true,
  })),
  meta: z.object({
    oldest_id: z.uuidv7().nullable(),
    more_data: z.boolean()
  })
});

const createPromptVersionRequest = promptVersionShape.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

const createPromptVersionResponse = promptVersionShape;

const updatePromptVersionRequest = promptVersionShape.omit({
  id: true,         // ID is not updated
  created_at: true, // Created at is not updated;
  updated_at: true, // Updated automatically
});

const updatePromptVersionResponse = promptVersionShape;

const deletePromptVersionRequest = z.object({
  id: z.uuidv7(),
});

const deletePromptVersionResponse = z.never();

export type GetPromptVersionResponse = z.infer<typeof getPromptVersionResponse>;
export type GetPromptVersionRequest = z.infer<typeof getPromptVersionRequest>;
export type ListPromptVersionsRequest = z.infer<typeof listPromptVersionsRequest>;
export type ListPromptVersionsResponse = z.infer<typeof listPromptVersionsResponse>;
export type CreatePromptVersionRequest = z.infer<typeof createPromptVersionRequest>;
export type CreatePromptVersionResponse = z.infer<typeof createPromptVersionResponse>;
export type UpdatePromptVersionRequest =  z.infer<typeof updatePromptVersionRequest>;
export type UpdatePromptVersionResponse = z.infer<typeof updatePromptVersionResponse>;
export type DeletePromptVersionRequest = z.infer<typeof deletePromptVersionRequest>;
export type DeletePromptVersionResponse = z.infer<typeof deletePromptVersionResponse>;

export default {
  getPromptRequest,
  getPromptResponse,
  listPromptsRequest,
  listPromptsResponse,
  createPromptRequest,
  createPromptResponse,
  updatePromptRequest,
  updatePromptResponse,
  deletePromptRequest,
  deletePromptResponse,

  getPromptVersionRequest,
  getPromptVersionResponse,
  listPromptVersionsRequest,
  listPromptVersionsResponse,
  createPromptVersionRequest,
  createPromptVersionResponse,
  updatePromptVersionRequest,
  updatePromptVersionResponse,
  deletePromptVersionRequest,
  deletePromptVersionResponse,
};
