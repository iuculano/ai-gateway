import { z } from '@hono/zod-openapi';
import { logs } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createSelectSchema } from 'drizzle-orm/zod';

const MAX_BATCH_SIZE = 100;

// It is apparently prohibited by spec to have all 0s
const traceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((value) => value !== '0'.repeat(32), 'Trace ID cannot be all zeros');

const logShape = createSelectSchema(logs)
  .omit({
    organization_id: true,
    request_object_reference: true, // server generated
    response_object_reference: true, // server generated
  })
  .extend({
    input_cost: z.coerce.number().nonnegative(),
    output_cost: z.coerce.number().nonnegative(),
    has_request: z.boolean(),
    has_response: z.boolean(),
  });

const getLog = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: logShape,
});

const getLogRequest = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.unknown(),
});

const getLogResponse = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.unknown(),
});

const batch = createSchema({
  body: z.object({
    ids: z.array(z.uuidv7()).min(1).max(MAX_BATCH_SIZE),
  }),

  response: z.object({
    data: z.record(z.uuidv7(), z.unknown()),
    meta: z.object({
      requested: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      missing: z.array(z.uuidv7()),
    }),
  }),
});

const listLogs = createSchema({
  query: z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),
    trace_id: traceId.optional(),
    tags: z.string().optional(), // "key1:value1,key2:value2"
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    before_id: z.uuidv7().optional(),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(logShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      newest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const deleteLog = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(), // 204 no content
});

const countLogs = createSchema({
  response: z.object({
    total: z.number().int().nonnegative(),
    estimated: z.boolean(),

    by_status: z.object({
      complete: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      incomplete: z.number().int().nonnegative(),
    }),
  }),
});

export type LogShape = z.infer<typeof logShape>;
export type GetLogResponse = z.infer<typeof getLog.response>;
export type GetLogPayloadResponse = z.infer<typeof z.unknown>;
export type BatchBody = z.infer<typeof batch.body>;
export type BatchResponse = z.infer<typeof batch.response>;
export type ListLogsQuery = z.infer<typeof listLogs.query>;
export type ListLogsResponse = z.infer<typeof listLogs.response>;
export type DeleteLogResponse = z.infer<typeof deleteLog.response>;
export type CountLogsResponse = z.infer<typeof countLogs.response>;

export default {
  getLog,
  getLogRequest,
  getLogResponse,
  batch,
  listLogs,
  deleteLog,
  countLogs,
};
