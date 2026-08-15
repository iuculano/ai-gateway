import { z } from '@hono/zod-openapi';
import { logs } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createSelectSchema } from 'drizzle-orm/zod';

/**
 * How many logs one batch may ask for.
 *
 * Each id costs one object-storage read, so this is the fan-out a single
 * request can provoke. 100 against a concurrency cap of 32 is a few overlapping
 * waves - large enough to be worth batching, small enough that it cannot be
 * used as an amplifier.
 */
const MAX_BATCH_SIZE = 100;

const logShape = createSelectSchema(logs)
  .omit({
    organization_id: true,

    // Internal. The keys say where a payload lives, which is nobody's business
    // outside this service - the /request and /response endpoints are the only
    // supported way to read one.
    request_object_reference: true,
    response_object_reference: true,
  })
  .extend({
    // Coerced, not plain z.number(). postgres hands `numeric` back as a STRING
    // to preserve precision, and $type<number>() on the column only changes the
    // TypeScript type - it installs no runtime mapper. A bare z.number() here
    // rejects every row the moment a cost is non-zero.
    input_cost: z.coerce.number().nonnegative(),
    output_cost: z.coerce.number().nonnegative(),

    // Derived from the columns above so a client knows whether following the
    // link is worth it. Either can be false: a caller can suppress one side
    // with ai-log-omit-request / ai-log-omit-response, and a request that
    // failed upstream never produces a response to store.
    has_request: z.boolean(),
    has_response: z.boolean(),
  });

/**
 * A stored payload.
 *
 * Deliberately untyped. The gateway logs whatever the endpoint handed it, and
 * pinning this to the chat-completions shape would both couple the two modules
 * and break the moment a second endpoint starts logging. Cloudflare documents
 * the equivalent responses the same way, as an open object.
 */
const payload = z.unknown();

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

  response: payload,
});

const getLogResponse = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: payload,
});

/**
 * The batch shape, shared by both payload sides.
 *
 * A miss is reported per id rather than failing the call. One unreadable object
 * says nothing about the other ninety-nine, and a batch that collapses on a
 * single absent payload is unusable against a store that is eventually
 * consistent or partially expired.
 */
const batch = createSchema({
  body: z.object({
    ids: z.array(z.uuidv7()).min(1).max(MAX_BATCH_SIZE),
  }),

  response: z.object({
    // Keyed by log id. Only ids that actually resolved appear here.
    data: z.record(z.uuidv7(), payload),
    meta: z.object({
      requested: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),

      // Ids that produced nothing: unknown to this organization, or known with
      // no payload stored on that side. The two are deliberately not
      // distinguished - telling a caller that a log id exists but belongs to
      // someone else is the leak the distinction would create.
      missing: z.array(z.uuidv7()),
    }),
  }),
});

const listLogs = createSchema({
  query: z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    status: z.enum(['incomplete', 'complete', 'failed']).optional(),
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

  response: z.void(),
});

/**
 * Tenant-wide totals.
 *
 * No filters, deliberately. Every figure below is either counted or derived
 * from statistics the planner keeps per column, and `tags` has neither - the
 * planner has no statistics for jsonb containment and returns the same
 * hardcoded guess whatever value it is given. A filtered variant would
 * therefore be exact for `status`, roughly right for `model`, and silently
 * meaningless for `tags`, which is a worse API than not offering it.
 *
 * `estimated` is the honest part of the contract: past a threshold these stop
 * being counts. It is a field rather than a separate endpoint because the
 * caller renders the same panel either way and only needs to know whether to
 * prefix a "~".
 */
const stats = createSchema({
  response: z.object({
    // The sum of by_status, so the three always add up to it - see getLogStats
    // for why that is built rather than asserted.
    total: z.number().int().nonnegative(),

    // False when every number was counted, true when they were sampled.
    estimated: z.boolean(),

    by_status: z.object({
      complete: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      incomplete: z.number().int().nonnegative(),
    }),

    tokens: z.object({
      // Coerced for the same reason the costs below are: these are summed in
      // postgres as bigint, and the driver hands bigint back as a string.
      input: z.coerce.number().int().nonnegative(),
      output: z.coerce.number().int().nonnegative(),
      total: z.coerce.number().int().nonnegative(),
    }),

    cost: z.object({
      input: z.coerce.number().nonnegative(),
      output: z.coerce.number().nonnegative(),
      total: z.coerce.number().nonnegative(),
    }),
  }),
});

export type LogShape = z.infer<typeof logShape>;
export type GetLogResponse = z.infer<typeof getLog.response>;
export type GetLogPayloadResponse = z.infer<typeof payload>;
export type BatchBody = z.infer<typeof batch.body>;
export type BatchResponse = z.infer<typeof batch.response>;
export type ListLogsQuery = z.infer<typeof listLogs.query>;
export type ListLogsResponse = z.infer<typeof listLogs.response>;
export type DeleteLogResponse = z.infer<typeof deleteLog.response>;
export type LogStatsResponse = z.infer<typeof stats.response>;

export default {
  getLog,
  getLogRequest,
  getLogResponse,
  batch,
  listLogs,
  deleteLog,
  stats,
};
