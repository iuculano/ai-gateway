import { z } from '@hono/zod-openapi';
import { apiKeys } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/zod';

const apiKeyShape = createSelectSchema(apiKeys).omit({
  organization_id: true, //internal detail
  key_hash: true, // this should only be included in the create response
});

const getApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: apiKeyShape,
});

const getApiKeyStats = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  // Redis backed, this response shape isn't rooted in the database schema
  response: z.object({
    id: z.uuidv7(),
    total_requests: z.number().int().nonnegative(),
    last_used_at: z.coerce.date().nullable(),

    current_window: z
      .object({
        used: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        resets_at: z.coerce.date(),
      })
      .nullable(),
  }),
});

const listApiKeys = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(),
    status: z.enum(['all', 'active']).optional().default('all'), // 'active' is served by the api_keys_org_active_idx partial index.
  }),

  response: z.object({
    // total_requests is redis-backed rather than a column, hydrated onto each
    // row after the query - the table has a Requests column, and a per-row call
    // to the stats endpoint to fill it would be one request per key.
    data: z.array(apiKeyShape.extend({ total_requests: z.number().int().nonnegative() })),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createApiKey = createSchema({
  body: createInsertSchema(apiKeys)
    .omit({
      id: true, // server-generated
      organization_id: true, // supplied from the caller
      created_at: true, // server-generated
      updated_at: true, // server-generated
      creator_id: true, // supplied from the caller
      key_hash: true, // server-generated
      revoked_by: true, // supplied from the caller
      revoked_at: true, // server-generated
    })
    .extend({
      expires_at: z.coerce.date().nullable().optional(),
      rate_limit_requests: z.number().int().min(1).nullish(),
      rate_limit_window: z.number().int().min(1).optional(),
    })
    // A quota with no window to spend it in cannot be enforced, and the key
    // would be unusable rather than merely unlimited: the fixed-window limiter
    // reads the window on every request the key authenticates. Body-local here
    // because at creation the body IS the whole row - the update path has to
    // check the merged row instead, see UpdateApiKeyFailure.
    .refine((body) => body.rate_limit_requests == null || body.rate_limit_window != null, {
      message: 'rate_limit_window is required when rate_limit_requests is set',
      path: ['rate_limit_window'],
    }),

  // The plaintext key is returned exactly once, at creation.
  response: apiKeyShape.extend({
    key: z.string(),
  }),
});

const updateApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: createUpdateSchema(apiKeys)
    .omit({
      id: true, // server-generated
      organization_id: true, // supplied from the caller
      created_at: true, // server-generated
      updated_at: true, // server-generated
      creator_id: true, // supplied from the caller
      key_hash: true, // server-generated
      revoked_by: true, // supplied from the caller
      revoked_at: true, // server-generated
    })
    .extend({
      expires_at: z.coerce.date().nullable().optional(),
      rate_limit_requests: z.number().int().min(1).nullish(),
      rate_limit_window: z.number().int().min(1).optional(),
    }),

  response: apiKeyShape,
});

const revokeApiKey = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

export type GetApiKeyParams = z.infer<typeof getApiKey.params>;
export type GetApiKeyResponse = z.infer<typeof getApiKey.response>;
export type GetApiKeyStatsParams = z.infer<typeof getApiKeyStats.params>;
export type GetApiKeyStatsResponse = z.infer<typeof getApiKeyStats.response>;
export type ListApiKeysQuery = z.infer<typeof listApiKeys.query>;
export type ListApiKeysResponse = z.infer<typeof listApiKeys.response>;
export type CreateApiKeyBody = z.infer<typeof createApiKey.body>;
export type CreateApiKeyResponse = z.infer<typeof createApiKey.response>;
export type UpdateApiKeyParams = z.infer<typeof updateApiKey.params>;
export type UpdateApiKeyBody = z.infer<typeof updateApiKey.body>;
export type UpdateApiKeyResponse = z.infer<typeof updateApiKey.response>;
export type RevokeApiKeyParams = z.infer<typeof revokeApiKey.params>;
export type RevokeApiKeyResponse = z.infer<typeof revokeApiKey.response>;

export default {
  getApiKey,
  getApiKeyStats,
  listApiKeys,
  createApiKey,
  updateApiKey,
  revokeApiKey,
};
