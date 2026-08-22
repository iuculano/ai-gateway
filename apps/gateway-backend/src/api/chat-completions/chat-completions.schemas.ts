import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

/**
 * An arbitrary JSON Schema document, carried through to the provider verbatim.
 *
 * Not validated beyond "is an object" on purpose - the provider is the
 * authority on what it accepts, and a stricter local model would reject
 * schemas that work fine upstream.
 */
const jsonSchema = z.record(z.string(), z.unknown());

/**
 * A rate limit policy, in the IETF quota-policy spelling the deleted
 * @repo/rate-limiter used: `<quota>;w=<window>`, for example `1000;w=3600`.
 *
 * Parsed here rather than in the handler so a malformed value is a normal 400
 * from request validation - naming the header and the expected format - rather
 * than a hand-rolled check several layers in.
 */
const rateLimitPolicy = z
  .string()
  .regex(/^[1-9]\d*;w=[1-9]\d*$/, 'Expected "<quota>;w=<window>" with positive integers, for example "1000;w=3600"')
  .transform((value) => {
    // The regex above already proved both halves are positive integers, so
    // neither Number() can produce NaN here.
    const [quota, window] = value.split(';w=');
    return {
      quota: Number(quota),
      windowSeconds: Number(window),
    };
  });

/**
 * Gateway headers.
 *
 * These are the gateway's own controls and sit alongside - never replace - the
 * `Authorization: Bearer aik_...` credential that authenticate() consumes.
 *
 * Header values are always strings on the wire. That matters for the booleans:
 * z.coerce.boolean() is plain JS truthiness, so it reads the string "false" as
 * true. z.stringbool() understands the actual spellings and rejects the rest.
 */
const headers = z.object({
  // Bring-your-own-key. The caller authenticates to the GATEWAY with its aik_
  // key and supplies the UPSTREAM provider credential here - two deliberately
  // different secrets, so a leaked gateway key cannot spend the provider quota.
  'ai-api-key': z.string().min(1),

  'ai-base-url': z.url().optional(),
  'ai-rate-limit-policy': rateLimitPolicy.optional(),

  // Tags recorded on this request's log, in the same "k1:v1,k2:v2" spelling
  // the logs list endpoint filters by. These are what a webhook's `filter`
  // matches against, so a log without them reaches only unfiltered webhooks.
  'ai-log-tags': z.string().optional(),

  'ai-log-omit-request': z.stringbool().optional(),
  'ai-log-omit-response': z.stringbool().optional(),

  'ai-max-retries': z.coerce.number().int().min(0).max(10).optional(),
  'ai-timeout-ms': z.coerce.number().int().positive().optional(),
  'ai-webhook-id': z.uuidv7().optional(),
});

const textPart = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    // Either an http(s) URL or a data: URI. Both are handed to the provider as
    // given; the SDK is what decides whether to download or inline.
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

const toolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    // A JSON *string*, not an object. That is what OpenAI emits and what it
    // expects back on the next turn.
    arguments: z.string(),
  }),
});

const systemMessage = z.object({
  role: z.literal('system'),
  content: z.union([z.string(), z.array(textPart).min(1)]),
  name: z.string().optional(),
});

// OpenAI's successor to `system`. Folded onto the system role on the way to the
// provider - see toModelMessages() - because the SDK has no separate one.
const developerMessage = z.object({
  role: z.literal('developer'),
  content: z.union([z.string(), z.array(textPart).min(1)]),
  name: z.string().optional(),
});

const userMessage = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(z.union([textPart, imagePart])).min(1)]),
  name: z.string().optional(),
});

const assistantMessage = z.object({
  role: z.literal('assistant'),
  // Null when the turn was nothing but tool calls, which is why this cannot
  // simply be a required string.
  content: z.union([z.string(), z.array(textPart), z.null()]).optional(),
  refusal: z.string().nullish(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).min(1).optional(),
});

const toolMessage = z.object({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(textPart).min(1)]),
  tool_call_id: z.string(),
});

const message = z.discriminatedUnion('role', [
  systemMessage,
  developerMessage,
  userMessage,
  assistantMessage,
  toolMessage,
]);

const functionTool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: jsonSchema.optional(),
    strict: z.boolean().nullish(),
  }),
});

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
    }),
  }),
]);

const responseFormat = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: jsonSchema.optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);

const prediction = z.object({
  type: z.literal('content'),
  content: z.union([z.string(), z.array(textPart)]),
});

/**
 * A reference to a stored prompt, expanded before the request leaves here.
 *
 * A field of its own rather than a marker inside a message: `content` is where
 * end-user text flows, and triggering expansion from it would let anyone who
 * can put words in a conversation pull in a prompt. This field is only ever set
 * by whoever is calling the API.
 *
 * Optional, so a stock OpenAI client that has never heard of it sends exactly
 * the same body it always did.
 */
const promptReference = z.object({
  /** Resolved within the caller's organization. Names are unique per org. */
  name: z.string().min(1),

  /**
   * Pins the version. Omitted, the prompt's active version is used - which is
   * what makes promoting a version take effect without a redeploy, and what
   * makes a pinned request reproducible when you would rather it did not.
   */
  version: z.number().int().positive().nullish(),

  variables: z.record(z.string(), z.string()).nullish(),
});

const body = z.object({
  // Either a bare OpenAI model id (`gpt-5`) or a `provider/model` slug
  // (`azure/my-deployment`). A bare id resolves to the openai provider, so a
  // stock OpenAI client works against this endpoint unmodified.
  model: z.string().min(1),
  messages: z.array(message).min(1),

  // Expanded into a leading system message, ahead of `messages`. The array
  // stays required: a prompt supplies the instructions, the caller still
  // supplies the turn being answered.
  prompt: promptReference.nullish(),

  frequency_penalty: z.number().min(-2).max(2).nullish(),
  logit_bias: z.record(z.string(), z.number().min(-100).max(100)).nullish(),
  logprobs: z.boolean().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  // Superseded by max_completion_tokens upstream, still accepted because
  // plenty of clients emit it. max_completion_tokens wins when both are set.
  max_tokens: z.number().int().positive().nullish(),
  metadata: z.record(z.string().max(64), z.string().max(512)).nullish(),

  // Only one choice per request. The generation path produces exactly one
  // candidate, so accepting n > 1 and returning a single choice would be a
  // silent lie - a 400 that names the field is the honest answer.
  n: z.literal(1).nullish(),

  parallel_tool_calls: z.boolean().nullish(),
  prediction: prediction.nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  prompt_cache_key: z.string().nullish(),
  prompt_cache_retention: z.enum(['in-memory', '24h']).nullish(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullish(),
  response_format: responseFormat.nullish(),
  safety_identifier: z.string().max(64).nullish(),
  seed: z.number().int().nullish(),
  service_tier: z.enum(['auto', 'default', 'flex', 'priority']).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  store: z.boolean().nullish(),
  stream: z.boolean().nullish(),
  stream_options: z
    .object({
      include_usage: z.boolean().nullish(),
    })
    .nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  tool_choice: toolChoice.nullish(),
  tools: z.array(functionTool).nullish(),
  top_logprobs: z.number().int().min(0).max(20).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  user: z.string().nullish(),
  verbosity: z.enum(['low', 'medium', 'high']).nullish(),
});

/**
 * OpenAI's finish_reason set.
 *
 * Deliberately narrower than the SDK's, which also has `error` and `other`.
 * mapFinishReason() is where that collapse happens.
 */
const finishReason = z.enum(['stop', 'length', 'tool_calls', 'content_filter']);

const usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  completion_tokens_details: z
    .object({
      reasoning_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

const completion = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      message: z.object({
        role: z.literal('assistant'),
        content: z.string().nullable(),
        refusal: z.string().nullable(),
        tool_calls: z.array(toolCall).optional(),
      }),
      logprobs: z.unknown().nullable(),
      finish_reason: finishReason,
    }),
  ),
  usage: usage,
  service_tier: z.string().optional(),
  system_fingerprint: z.string().optional(),
});

/**
 * A streamed frame. One of these per `data:` line, then a literal `[DONE]`.
 */
const completionChunk = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({
        role: z.literal('assistant').optional(),
        content: z.string().nullish(),
        refusal: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              // Present on every tool-call delta so the client knows which
              // call in the array it is patching.
              index: z.number().int().nonnegative(),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z
                .object({
                  name: z.string().optional(),
                  arguments: z.string().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
      logprobs: z.unknown().nullish(),
      finish_reason: finishReason.nullable(),
    }),
  ),
  // Only ever populated on the final frame, and only when the caller asked for
  // it with stream_options.include_usage.
  usage: usage.nullish(),
});

const createChatCompletion = createSchema({
  headers: headers,
  body: body,
  response: completion,
});

export type ChatCompletionHeaders = z.infer<typeof headers>;
export type ChatCompletionBody = z.infer<typeof body>;
export type PromptReference = z.infer<typeof promptReference>;
export type ChatCompletion = z.infer<typeof completion>;
export type ChatCompletionChunk = z.infer<typeof completionChunk>;
export type ChatCompletionMessage = z.infer<typeof message>;
export type ChatCompletionUsage = z.infer<typeof usage>;
export type ChatCompletionFinishReason = z.infer<typeof finishReason>;
export type ChatCompletionToolCall = z.infer<typeof toolCall>;
export type RateLimitPolicy = z.infer<typeof rateLimitPolicy>;

export default {
  createChatCompletion,
  completionChunk,
};
