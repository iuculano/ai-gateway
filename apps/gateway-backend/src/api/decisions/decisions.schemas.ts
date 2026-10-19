import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const headers = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),

  'ai-api-key': z.string().min(1),
  'ai-base-url': z.url().optional(),
  'ai-routing-strategy': z.enum(['random', 'weighted', 'cost']).optional(),
  'ai-routing-weights': z.string().optional(),
  'ai-log-tags': z.string().optional(),
  'ai-log-omit-request': z.stringbool().optional(),
  'ai-log-omit-response': z.stringbool().optional(),
  'ai-timeout-ms': z.coerce.number().int().positive().optional(),
});

const responseHeaders = z.object({
  'ai-trace-id': z.string().regex(/^[0-9a-f]{32}$/),
});

const predicateQuestion = z.object({
  type: z.literal('predicate'),
  name: z.string().min(1),
  instructions: z.string().min(1),
});

const choiceQuestion = z.object({
  type: z.literal('choice'),
  name: z.string().min(1),
  instructions: z.string().min(1),
  choices: z
    .array(
      z.object({
        value: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .min(1)
    .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length, {
      message: 'Choice values must be unique',
    }),
});

const scoreQuestion = z.object({
  type: z.literal('score'),
  name: z.string().min(1),
  instructions: z.string().min(1),
  levels: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .min(2),
});

const question = z.discriminatedUnion('type', [predicateQuestion, choiceQuestion, scoreQuestion]);

const body = z.object({
  model: z.string().min(1), // This is a little special here and can be 'provider/model' instead...
  input: z.string().min(1),
  questions: z.array(question).min(1),
  safety_identifier: z.string().max(128).nullish(),
});

const probability = z.number().min(0).max(1);

const answer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('predicate'),
    name: z.string(),
    probability: probability,
  }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    probabilities: z.array(z.object({ value: z.string(), probability: probability })),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number(),
    probabilities: z.array(
      z.object({
        value: z.number().int().nonnegative(),
        label: z.string(),
        probability: probability,
      }),
    ),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal('refusal'),
    name: z.string(),
  }),
]);

const decision = z.object({
  model: z.string(),
  answers: z.array(answer),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

const createDecision = createSchema({
  headers: headers,
  body: body,
  response: decision,
});

export type CreateDecisionHeaders = z.infer<typeof createDecision.headers>;
export type CreateDecisionBody = z.infer<typeof createDecision.body>;
export type CreateDecisionResponse = z.infer<typeof createDecision.response>;

export default {
  createDecision,
  responseHeaders,
};
