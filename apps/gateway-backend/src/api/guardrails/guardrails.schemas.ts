import { z } from '@hono/zod-openapi';
import { guardrails } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/zod';

/**
 * A pattern long enough to express anything reasonable and short enough that
 * the compiler is not handed something pathological by length alone.
 */
const MAX_PATTERN_LENGTH = 1000;

/**
 * Flags a caller may set.
 *
 * `g` and `y` are deliberately absent. Both make a RegExp stateful through
 * `lastIndex`, and these patterns are compiled once and reused across requests -
 * a `g` pattern reused that way answers differently on alternate calls. Matching
 * adds `g` itself, at the point where doing so is safe. See compile() in
 * guardrails.services.ts.
 */
const ALLOWED_FLAGS = /^[imsu]*$/;

/**
 * The `config` blob of a 'regex' guardrail.
 *
 * This is the boundary check the single-table design trades for: postgres holds
 * `config` as opaque json, so this schema is the only thing standing between a
 * caller and a row whose pattern does not compile.
 */
export const regexConfig = z
  .object({
    pattern: z.string().min(1).max(MAX_PATTERN_LENGTH),
    flags: z.string().max(4).regex(ALLOWED_FLAGS, 'flags may only contain i, m, s and u').optional(),
  })
  .refine(
    (config) => {
      try {
        new RegExp(config.pattern, config.flags);
        return true;
      } catch {
        return false;
      }
    },
    {
      // Validated as a pair rather than field by field: `u` rejects escapes
      // that are legal without it, so a pattern is only valid alongside the
      // flags it will actually be compiled with.
      message: 'pattern is not a valid regular expression under the given flags',
      path: ['pattern'],
    },
  );

const guardrailShape = createSelectSchema(guardrails)
  .omit({
    organization_id: true,
  })
  .extend({
    // Left open here because this shape covers every type. The typed routes
    // below narrow it to the config schema their `type` selects, which is what
    // puts a concrete object in the OpenAPI document instead of a blob.
    config: z.record(z.string(), z.unknown()),
  });

/** The regex flavour, returned by the routes where the type is fixed by the path. */
const regexGuardrailShape = guardrailShape.extend({
  type: z.literal('regex'),
  config: regexConfig,
});

// Columns the caller never supplies, on either write path.
const serverOwnedColumns = {
  id: true, // server-generated
  organization_id: true, // supplied from the caller
  creator_id: true, // supplied from the caller
  type: true, // fixed by the route
  config: true, // replaced by the type's own schema
  created_at: true, // server-generated
  updated_at: true, // server-generated
} as const;

const getGuardrail = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: guardrailShape,
});

const listGuardrails = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(),
    type: z.enum(['regex']).optional(),
    enabled: z.stringbool().optional(),
  }),

  response: z.object({
    data: z.array(guardrailShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createRegexGuardrail = createSchema({
  body: createInsertSchema(guardrails).omit(serverOwnedColumns).extend({
    config: regexConfig,
  }),

  response: regexGuardrailShape,
});

const updateRegexGuardrail = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: createUpdateSchema(guardrails).omit(serverOwnedColumns).extend({
    config: regexConfig.optional(),
  }),

  response: regexGuardrailShape,
});

const deleteGuardrail = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

//---

/**
 * The outcome of running one guardrail against one side of the exchange.
 *
 * `target` is the side actually checked, so it is never 'both' - a guardrail
 * configured for both sides produces two of these.
 */
const evaluationResult = z.object({
  guardrail_id: z.uuidv7(),
  name: z.string(),
  type: z.enum(['regex']),
  target: z.enum(['request', 'response']),
  action: z.enum(['block', 'flag']),
  passed: z.boolean(),

  matches: z.array(
    z.object({
      value: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),

  // Set when the guardrail could not be run at all. Such a result is reported
  // as failed rather than skipped - see evaluateGuardrails().
  error: z.string().nullish(),
});

const evaluateGuardrails = createSchema({
  body: z
    .object({
      request: z.string().optional(),
      response: z.string().optional(),

      // Restricts the run to specific guardrails. Omitted, every enabled
      // guardrail in the organization is applied.
      guardrail_ids: z.array(z.uuidv7()).max(100).optional(),
    })
    .refine((body) => body.request !== undefined || body.response !== undefined, {
      message: 'at least one of request or response must be supplied',
    }),

  response: z.object({
    passed: z.boolean(),

    // The most severe action any failing guardrail asked for, or null when
    // nothing failed. Advisory: this endpoint reports, it does not enforce.
    action: z.enum(['block', 'flag']).nullable(),

    results: z.array(evaluationResult),
  }),
});

export type RegexConfig = z.infer<typeof regexConfig>;
export type GetGuardrailParams = z.infer<typeof getGuardrail.params>;
export type GetGuardrailResponse = z.infer<typeof getGuardrail.response>;
export type ListGuardrailsQuery = z.infer<typeof listGuardrails.query>;
export type ListGuardrailsResponse = z.infer<typeof listGuardrails.response>;
export type CreateRegexGuardrailBody = z.infer<typeof createRegexGuardrail.body>;
export type CreateRegexGuardrailResponse = z.infer<typeof createRegexGuardrail.response>;
export type UpdateRegexGuardrailParams = z.infer<typeof updateRegexGuardrail.params>;
export type UpdateRegexGuardrailBody = z.infer<typeof updateRegexGuardrail.body>;
export type UpdateRegexGuardrailResponse = z.infer<typeof updateRegexGuardrail.response>;
export type DeleteGuardrailParams = z.infer<typeof deleteGuardrail.params>;
export type DeleteGuardrailResponse = z.infer<typeof deleteGuardrail.response>;
export type EvaluateGuardrailsBody = z.infer<typeof evaluateGuardrails.body>;
export type EvaluateGuardrailsResponse = z.infer<typeof evaluateGuardrails.response>;
export type EvaluationResult = z.infer<typeof evaluationResult>;

export default {
  getGuardrail,
  listGuardrails,
  createRegexGuardrail,
  updateRegexGuardrail,
  deleteGuardrail,

  evaluateGuardrails,
};
