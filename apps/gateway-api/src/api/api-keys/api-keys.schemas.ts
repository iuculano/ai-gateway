import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const apiKeyShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  description: z.string().nullish().transform(x => x ?? undefined),
  key_hash: z.string(),
  expires_at: z.coerce.date().nullish().transform((date) => date ? date.toISOString() : undefined),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: apiKeyShape.omit({
    key_hash: true,
  }),
});

const listApiKeys = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(apiKeyShape.omit({
      key_hash: true,
    })),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean()
    }),
  }),
});

const createApiKey = createSchema({
  body: apiKeyShape.omit({
    id: true,
    key_hash: true,
    created_at: true,
    updated_at: true,
  }),

  response: apiKeyShape,
});

const updateApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: apiKeyShape.partial().omit({
    id: true,
    key_hash: true,
    created_at: true,
    updated_at: true,
  }),

  response: apiKeyShape,
});

const deleteApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

export type GetApiKeyParams = z.infer<typeof getApiKey.params>;
export type GetApiKeyResponse = z.infer<typeof getApiKey.response>;
export type ListApiKeysQuery = z.infer<typeof listApiKeys.query>;
export type ListApiKeysResponse = z.infer<typeof listApiKeys.response>;
export type CreateApiKeyBody = z.infer<typeof createApiKey.body>;
export type CreateApiKeyResponse = z.infer<typeof createApiKey.response>;
export type UpdateApiKeyParams = z.infer<typeof updateApiKey.params>;
export type UpdateApiKeyBody =  z.infer<typeof updateApiKey.body>;
export type UpdateApiKeyResponse = z.infer<typeof updateApiKey.response>;
export type DeleteApiKeyParams = z.infer<typeof deleteApiKey.params>;
export type DeleteApiKeyResponse = z.infer<typeof deleteApiKey.response>;

export default {
  getApiKey,
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
};
