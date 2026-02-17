import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';


const promptShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  description: z.string().nullish(),
  active_version: z.number().nullable().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: promptShape,
});

const listPrompts = createSchema({
  query: z.object({
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(promptShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean()
    })
  }),
});

const createPrompt = createSchema({
  body: promptShape.omit({
    id: true,
    active_version: true, // No version can exist yet
    created_at: true,
    updated_at: true,
  }),

  response: promptShape,
});

const updatePrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: promptShape.partial().omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: promptShape,
});

const deletePrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

const promptVersionShape = z.object({
  id: z.uuidv7(),
  prompt_id: z.uuidv7(),
  prompt: z.string(),
  version: z.coerce.number().positive(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  response: promptVersionShape,
});

const listPromptVersions = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(promptVersionShape.omit({
      prompt: true,
    })),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean()
    }),
  }),
});

const createPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: z.object({
    prompt: z.string(),
  }),

  response: promptVersionShape,
});

const updatePromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.number().positive(),
  }),

  body: promptVersionShape.omit({
    id: true,
    prompt_id: true,
    version: true,
    created_at: true,
    updated_at: true,
  }),

  response: promptVersionShape,
});

const deletePromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  response: z.void(),
});

const renderPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  body: z.object({
    inputs: z.record(z.string(), z.string()),
  }),

  response: z.object({
    prompt: z.string(),
  }),
});

export type GetPromptParams = z.infer<typeof getPrompt.params>;
export type GetPromptResponse = z.infer<typeof getPrompt.response>;
export type ListPromptsQuery = z.infer<typeof listPrompts.query>;
export type ListPromptsResponse = z.infer<typeof listPrompts.response>;
export type CreatePromptBody = z.infer<typeof createPrompt.body>;
export type CreatePromptResponse = z.infer<typeof createPrompt.response>;
export type UpdatePromptParams = z.infer<typeof updatePrompt.params>;
export type UpdatePromptBody =  z.infer<typeof updatePrompt.body>;
export type UpdatePromptResponse = z.infer<typeof updatePrompt.response>;
export type DeletePromptParams = z.infer<typeof deletePrompt.params>;
export type DeletePromptResponse = z.infer<typeof deletePrompt.response>;

export type GetPromptVersionParams = z.infer<typeof getPromptVersion.params>;
export type GetPromptVersionResponse = z.infer<typeof getPromptVersion.response>;
export type ListPromptVersionsQuery = z.infer<typeof listPromptVersions.query>;
export type ListPromptVersionsResponse = z.infer<typeof listPromptVersions.response>;
export type CreatePromptVersionParams = z.infer<typeof createPromptVersion.params>;
export type CreatePromptVersionBody = z.infer<typeof createPromptVersion.body>;
export type CreatePromptVersionResponse = z.infer<typeof createPromptVersion.response>;
export type UpdatePromptVersionParams = z.infer<typeof updatePromptVersion.params>;
export type UpdatePromptVersionBody = z.infer<typeof updatePromptVersion.body>;
export type UpdatePromptVersionResponse = z.infer<typeof updatePromptVersion.response>;
export type DeletePromptVersionParams = z.infer<typeof deletePromptVersion.params>;
export type DeletePromptVersionResponse = z.infer<typeof deletePromptVersion.response>;
export type RenderPromptVersionParams = z.infer<typeof renderPromptVersion.params>;
export type RenderPromptVersionBody = z.infer<typeof renderPromptVersion.body>;
export type RenderPromptVersionResponse = z.infer<typeof renderPromptVersion.response>;

export default {
  getPrompt,
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
};
