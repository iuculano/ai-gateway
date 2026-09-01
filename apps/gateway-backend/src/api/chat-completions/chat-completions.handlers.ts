import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { type Caller, getActorId, getCaller, zodExceptionHook } from '@repo/hono';
import { consumeFixedWindowCounter } from '@repo/redis';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { Result } from 'neverthrow';
import PromptServices, { type ResolvePromptFailure } from '../prompts/prompts.services';
import Routes from './chat-completions.routes';
import type { ChatCompletionBody, ChatCompletionChunk, RateLimitPolicy } from './chat-completions.schemas';
import Services, {
  type CreateChatCompletionFailure,
  type StreamChatCompletionFailure,
} from './chat-completions.services';

/**
 * Returns a Redis key for rate limiting.
 *
 * @param id
 * The ID of the API key.
 *
 * @returns
 * The Redis key for the API key's quota counter.
 */
function rateLimitKey(caller: Caller): string {
  return `chat-completions:${caller.organization.id}:${getActorId(caller)}`;
}

/**
 * Acts on the caller's requested rate limit policy.
 *
 * @param caller
 * The authenticated caller for the current request.
 *
 * @param policy
 * The parsed policy from the ai-rate-limit-policy header.
 *
 * @returns
 * The headers to set on a successful response.
 *
 * @throws {HTTPException}
 * 429 when the caller is over quota, carrying the same headers plus Retry-After.
 */
async function enforceRateLimit(caller: Caller, policy: RateLimitPolicy): Promise<Headers> {
  const result = await consumeFixedWindowCounter(rateLimitKey(caller), {
    limit: policy.quota,
    windowSeconds: policy.windowSeconds,
  });

  const headers = new Headers();

  // Both spellings. The IETF draft names are the standard ones; the X- forms
  // are what most clients in the wild actually read.
  //
  // RateLimit-Limit is the LIMIT. It previously carried the consumed count,
  // which made every response advertise a ceiling that climbed as quota was
  // spent.
  for (const [name, value] of [
    ['RateLimit-Limit', result.limit],
    ['RateLimit-Remaining', result.remainingQuota],
  ] as const) {
    headers.set(name, value.toString());
    headers.set(`X-${name}`, value.toString());
  }

  // Only known once the window is actually being enforced - the limiter
  // reports the reset as a retry-after, which is null while the caller is
  // still under quota. Omitted rather than guessed.
  if (result.retryAfterSeconds != null) {
    headers.set('RateLimit-Reset', result.retryAfterSeconds.toString());
    headers.set('X-RateLimit-Reset', result.retryAfterSeconds.toString());
  }

  if (result.isLimited) {
    const retryAfter = result.retryAfterSeconds ?? policy.windowSeconds;
    headers.set('Retry-After', retryAfter.toString());

    throw new HTTPException(429, {
      message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
      res: new Response(null, { headers: headers }),
    });
  }

  return headers;
}

// The HTTP translations, one per service failure union.
function toResolvePromptHttpException(failure: ResolvePromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'PROMPT_FORBIDDEN':
      return new HTTPException(403, {
        message: `Expanding a prompt requires the '${failure.required}' scope`,
        res: new Response(null, {
          headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${failure.required}"` },
        }),
      });

    case 'PROMPT_NOT_FOUND':
      return new HTTPException(404, {
        message: `No prompt named '${failure.name}'`,
      });

    case 'PROMPT_NO_ACTIVE_VERSION':
      return new HTTPException(422, {
        message: `Prompt '${failure.name}' has no active version. Publish one, or pin a version on the request.`,
      });

    case 'PROMPT_VERSION_NOT_FOUND':
      return new HTTPException(404, {
        message: `Prompt '${failure.name}' has no version ${failure.version}`,
      });

    case 'PROMPT_VARIABLES_MISSING':
      return new HTTPException(422, {
        message: `Prompt '${failure.name}' v${failure.version} requires variables that were not supplied: ${failure.missing.join(', ')}`,
      });

    default:
      return assertNever(code);
  }
}

function toChatCompletionHttpException(
  failure: CreateChatCompletionFailure | StreamChatCompletionFailure,
): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'MODEL_NOT_FOUND':
      return new HTTPException(404, {
        message: `Model '${failure.model}' is not registered in the catalogue`,
      });

    case 'UNSUPPORTED_MODEL_PROVIDER':
      return new HTTPException(400, {
        message: `Model '${failure.model}' uses unsupported provider '${failure.provider}'`,
      });

    case 'UNKNOWN_TOOL_CALL':
      return new HTTPException(400, {
        message:
          `Tool message references tool_call_id '${failure.tool_call_id}', which no ` +
          'preceding assistant message issued',
      });

    case 'UNSUPPORTED_RESPONSE_FORMAT':
      return new HTTPException(400, {
        message: `response_format '${failure.response_format}' is not supported by this gateway`,
      });

    case 'TOP_LOGPROBS_REQUIRES_LOGPROBS':
      return new HTTPException(400, {
        message: 'top_logprobs requires logprobs to be true',
      });

    case 'WEBHOOK_LOG_UNAVAILABLE':
      return new HTTPException(503, {
        message: 'Cannot queue a webhook delivery: the log it would point at could not be opened',
      });

    case 'WEBHOOK_NOT_FOUND':
      return new HTTPException(404, {
        message: `No webhook with id '${failure.id}'`,
      });

    case 'PROVIDER_INVALID_REQUEST':
      return new HTTPException(400, {
        message: failure.message,
        cause: failure.cause,
      });

    case 'PROVIDER_REJECTED_REQUEST':
      return new HTTPException(failure.status as 400, {
        message: `Upstream provider rejected the request: ${failure.message}`,
        cause: failure.cause,
      });

    case 'PROVIDER_FAILED':
      return new HTTPException(502, {
        message:
          failure.message === 'Upstream provider call failed'
            ? failure.message
            : `Upstream provider failed: ${failure.message}`,
        cause: failure.cause,
      });

    case 'PROVIDER_TIMEOUT':
      return new HTTPException(504, {
        message: 'Upstream provider timed out',
        cause: failure.cause,
      });

    default:
      return assertNever(code);
  }
}

/**
 * Expands a prompt reference into a leading system message.
 *
 * @param body
 * The validated request body, which may or may not name a prompt.
 *
 * @returns
 * The body to send upstream, and the version that was expanded when one was.
 */
async function expandPrompt(body: ChatCompletionBody): Promise<{ body: ChatCompletionBody; version: number | null }> {
  if (!body.prompt) {
    return { body, version: null };
  }

  const resolved = await PromptServices.resolvePrompt(body.prompt);

  if (resolved.isErr()) {
    throw toResolvePromptHttpException(resolved.error);
  }

  // `prompt` is dropped on the way through - it is this gateway's field, and
  // the provider has no idea what it means.
  const { prompt: _reference, ...rest } = body;

  return {
    body: {
      ...rest,
      messages: [{ role: 'system', content: resolved.value.prompt }, ...body.messages],
    },
    version: resolved.value.version,
  };
}

/**
 * POST /chat/completions
 * Generate a chat completion, streamed or whole.
 */
const createChatCompletion = defineOpenAPIRoute({
  route: Routes.createChatCompletion,
  handler: async (c) => {
    const headers = c.req.valid('header');
    const body = c.req.valid('json');

    const policy = headers['ai-rate-limit-policy'];
    if (policy) {
      const rateLimitHeaders = await enforceRateLimit(getCaller(), policy);
      rateLimitHeaders.forEach((value, name) => {
        c.res.headers.set(name, value);
      });
    }

    // Before anything reaches the provider, and before the stream commits the
    // 200 - a prompt that will not expand has to be a normal error response.
    const expanded = await expandPrompt(body);

    // Which version actually produced this, echoed for the same reason as
    // ai-log-id. Without it, "what did we send" is unanswerable once the
    // active version moves.
    if (expanded.version !== null) {
      c.res.headers.set('ai-prompt-version', String(expanded.version));
    }

    // Echoed so a caller can fetch the stored payloads afterwards without
    // having to guess which log row was theirs.
    const echoLogId = (logId: string) => {
      c.res.headers.set('ai-log-id', logId);
    };

    if (!expanded.body.stream) {
      const result = await Services.createChatCompletion(headers, expanded.body, echoLogId);

      return result.match(
        (completion) => c.json(completion, 200),
        (failure) => {
          throw toChatCompletionHttpException(failure);
        },
      );
    }

    // The first chunk is pulled before streamSSE() takes over so that a
    // failure to even reach the provider is still a normal error response.
    // Once the stream opens, the 200 is committed and nothing can change it -
    // including the ai-log-id header, which is why the log has to be opened
    // before this point rather than when the stream finishes.
    const chunks = Services.streamChatCompletion(headers, expanded.body, echoLogId);
    const first = await chunks.next();

    const unwrap = (result: Result<ChatCompletionChunk, StreamChatCompletionFailure>) =>
      result.match(
        (chunk) => chunk,
        (failure) => {
          throw toChatCompletionHttpException(failure);
        },
      );

    // Unwrap before streamSSE commits a 200. Once the response begins, an Err
    // can only terminate the stream; before it begins, it remains a normal
    // JSON error response with the status chosen above.
    const firstChunk = first.done ? undefined : unwrap(first.value);

    return streamSSE(c, async (sse) => {
      if (firstChunk) {
        await sse.writeSSE({ data: JSON.stringify(firstChunk) });
      }

      for await (const result of chunks) {
        await sse.writeSSE({ data: JSON.stringify(unwrap(result)) });
      }

      await sse.writeSSE({ data: '[DONE]' });
    });
  },
});

const app = new OpenAPIHono({
  defaultHook: zodExceptionHook,
}).openapiRoutes([createChatCompletion] as const);

export default app;
