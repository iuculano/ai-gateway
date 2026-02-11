import { z } from '@hono/zod-openapi';


const promptShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  description: z.string().optional(),
  active_version: z.number().optional().default(1),
  tags: z.record(z.string(), z.string()).optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPromptParams = z.object({
  id: z.uuidv7(),
});

const getPromptResponse = promptShape;

const listPromptsQuery = z.object({
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

const createPromptBody = promptShape.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

const createPromptResponse = promptShape;

const updatePromptParams = z.object({
  id: z.uuidv7(),
});

const updatePromptBody = promptShape.partial().omit({
  id: true,         // ID is not updated
  created_at: true, // Created at is not updated;
  updated_at: true, // Updated automatically
});

const updatePromptResponse = promptShape;

const deletePromptParams = z.object({
  id: z.uuidv7(),
});

const deletePromptResponse = z.void();

const renderPromptParams = z.object({
  id: z.uuidv7(),
});

const renderPromptBody = z.object({
  inputs: z.record(z.string(), z.string()),
});

const renderPromptResponse = getPromptResponse;


export type GetPromptParams = z.infer<typeof getPromptParams>;
export type GetPromptResponse = z.infer<typeof getPromptResponse>;
export type ListPromptsQuery = z.infer<typeof listPromptsQuery>;
export type ListPromptsResponse = z.infer<typeof listPromptsResponse>;
export type CreatePromptBody = z.infer<typeof createPromptBody>;
export type CreatePromptResponse = z.infer<typeof createPromptResponse>;
export type UpdatePromptParams = z.infer<typeof updatePromptParams>;
export type UpdatePromptBody =  z.infer<typeof updatePromptBody>;
export type UpdatePromptResponse = z.infer<typeof updatePromptResponse>;
export type DeletePromptParams = z.infer<typeof deletePromptParams>;
export type DeletePromptResponse = z.infer<typeof deletePromptResponse>;
export type RenderPromptParams = z.infer<typeof renderPromptParams>;
export type RenderPromptBody = z.infer<typeof renderPromptBody>;
export type RenderPromptResponse = z.infer<typeof renderPromptResponse>;

const promptVersionShape = z.object({
  id: z.uuidv7(),
  prompt_id: z.uuidv7(),
  prompt: z.string(),
  version: z.number().positive(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPromptVersionParams = z.object({
  id: z.uuidv7(),
  version: z.number().positive(),
});

const getPromptVersionResponse = promptVersionShape;

const listPromptVersionsParams = z.object({
  id: z.uuidv7(),
});

const listPromptVersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).optional().default(25),
  after_id: z.uuidv7().optional(),
});

const listPromptVersionsResponse = z.object({
  data: z.array(promptVersionShape.omit({
    prompt_id: true, // Already implied by the route
    prompt: true,
  })),
  meta: z.object({
    oldest_id: z.uuidv7().nullable(),
    more_data: z.boolean()
  })
});

const createPromptVersionParams = z.object({
  id: z.uuidv7(),
});

const createPromptVersionBody = z.object({
  prompt: z.string(),
});

const createPromptVersionResponse = promptVersionShape;

// 
// const createPromptVersionResponse = promptVersionShape;
// 
// const updatePromptVersionRequest = promptVersionShape.omit({
//   id: true,         // ID is not updated
//   created_at: true, // Created at is not updated;
//   updated_at: true, // Updated automatically
// });
// 
// const updatePromptVersionResponse = promptVersionShape;
// 
// const deletePromptVersionRequest = z.object({
//   id: z.uuidv7(),
// });
// 
// const deletePromptVersionResponse = z.never();
// 

export type GetPromptVersionParams = z.infer<typeof getPromptVersionParams>;
export type GetPromptVersionResponse = z.infer<typeof getPromptVersionResponse>;
export type ListPromptVersionsQuery = z.infer<typeof listPromptVersionsQuery>;
export type ListPromptVersionsResponse = z.infer<typeof listPromptVersionsResponse>;
export type CreatePromptVersionParams = z.infer<typeof createPromptVersionParams>;
export type CreatePromptVersionBody = z.infer<typeof createPromptVersionBody>;
export type CreatePromptVersionResponse = z.infer<typeof createPromptVersionResponse>;

// export type CreatePromptVersionRequest = z.infer<typeof createPromptVersionRequest>;
// export type CreatePromptVersionResponse = z.infer<typeof createPromptVersionResponse>;
// export type UpdatePromptVersionRequest =  z.infer<typeof updatePromptVersionRequest>;
// export type UpdatePromptVersionResponse = z.infer<typeof updatePromptVersionResponse>;
// export type DeletePromptVersionRequest = z.infer<typeof deletePromptVersionRequest>;
// export type DeletePromptVersionResponse = z.infer<typeof deletePromptVersionResponse>;

export default {
  getPromptParams,
  getPromptResponse,
  listPromptsQuery,
  listPromptsResponse,
  createPromptBody,
  createPromptResponse,
  updatePromptParams,
  updatePromptBody,
  updatePromptResponse,
  deletePromptParams,
  deletePromptResponse,
  renderPromptParams,
  renderPromptBody,
  renderPromptResponse,

  getPromptVersionParams,
  getPromptVersionResponse,
  listPromptVersionsParams,
  listPromptVersionsQuery,
  listPromptVersionsResponse,
  createPromptVersionParams,
  createPromptVersionBody,
  createPromptVersionResponse,
};
