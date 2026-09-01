import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const timestamp = z.date().transform((date) => date.toISOString());

const nullableTimestamp = z
  .date()
  .nullable()
  .transform((date) => date?.toISOString() ?? null);

const price = z.coerce.number().nonnegative().nullable();

const modelShape = z.object({
  id: z.uuidv7(),

  // Which rows the catalogue worker owns. Built-ins are replaced on every sync;
  // custom rows are the organization's and are never touched by it.
  source: z.enum(['builtin', 'custom']),

  name: z.string(), // e.g., 'gpt-4-turbo'
  provider: z.string(),
  display_name: z.string().nullable(),

  status: z.enum(['available', 'beta', 'deprecated']),

  cost_input: price,
  cost_output: price,
  cost_cache_read: price,

  context_limit: z.coerce.number().int().nullable(),

  attachment: z.boolean(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  structured_output: z.boolean(),

  config: z.record(z.string(), z.unknown()).optional(),
  // Values are strings, matching the column's own $type - a looser record here
  // does not round-trip through an insert.
  tags: z.record(z.string(), z.string()).optional(),

  delisted_at: nullableTimestamp,
  synced_at: nullableTimestamp,

  created_at: timestamp,
  updated_at: timestamp,
});

const getModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: modelShape,
});

const listModels = createSchema({
  query: z.object({
    name: z.string().optional(),
    provider: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(modelShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

/**
 * The catalogue, grouped by provider.
 *
 * Separate from listModels rather than a mode of it: that one is a flat
 * cursor-paginated list, and a page boundary through a provider's models would
 * make every figure derived from the group - the price range, the model count -
 * a statement about a page rather than about the provider.
 */
const listProviders = createSchema({
  response: z.object({
    data: z.array(
      z.object({
        id: z.string(),

        // The newest sync across this provider's models. Diverges from the
        // others exactly when a provider stops arriving upstream.
        synced_at: nullableTimestamp,

        models: z.array(modelShape),
      }),
    ),
  }),
});

const createModel = createSchema({
  body: modelShape
    .omit({
      id: true,
      created_at: true,
      updated_at: true,
      delisted_at: true,
      synced_at: true,
    })
    .partial()
    .required({ name: true, provider: true }),

  response: modelShape,
});

const updateModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: modelShape.partial().omit({
    id: true, // server-generated
    created_at: true, // server-generated
    updated_at: true, // server-generated
    delisted_at: true, // server-generated
    synced_at: true, // server-generated
  }),

  response: modelShape,
});

const deleteModel = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

export type GetModelParams = z.infer<typeof getModel.params>;
export type GetModelResponse = z.infer<typeof getModel.response>;
export type ListModelsRequest = z.infer<typeof listModels.query>;
export type ListModelsResponse = z.infer<typeof listModels.response>;
export type ListProvidersResponse = z.infer<typeof listProviders.response>;
export type CreateModelRequest = z.infer<typeof createModel.body>;
export type CreateModelResponse = z.infer<typeof createModel.response>;
export type UpdateModelRequest = z.infer<typeof updateModel.body>;
export type UpdateModelResponse = z.infer<typeof updateModel.response>;
export type DeleteModelRequest = z.infer<typeof deleteModel.params>;
export type DeleteModelResponse = z.infer<typeof deleteModel.response>;

export default {
  getModel,
  listModels,
  listProviders,
  createModel,
  updateModel,
  deleteModel,
};
