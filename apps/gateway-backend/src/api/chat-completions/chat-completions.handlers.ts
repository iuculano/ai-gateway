import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { type Caller, getActorId, getCaller, zodExceptionHook } from '@repo/hono';
import { consumeFixedWindowCounter } from '@repo/redis';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import PromptServices, { type ResolvePromptFailure } from '../prompts/prompts.services';
import Routes from './chat-completions.routes';
import type { ChatCompletionBody, RateLimitPolicy } from './chat-completions.schemas';
import Services from './chat-completions.services';

/**
 * What the ai-rate-limit-policy header counts against.
 *
 * The API key, when the caller presented one - that is the credential actually
 * spending the quota, and two keys belonging to the same human should not share
 * a bucket. A JWT caller has no key, so the human is the next best subject.
 *
 * Note this is no longer the client IP. It used to be, which forced a 503 when
 * the address could not be read and shared one bucket across everyone behind a
 * NAT. Both problems disappear now that every request is authenticated.
 *
 * @param caller
 * The authenticated caller for the current request.
 *
 * @returns
 * A Redis key unique to the caller.
 */
function rateLimitKey(caller: Caller): string {
  return `chat-completions:${caller.organization.id}:${getActorId(caller)}`;
}

/**
 * Applies the caller's requested rate limit policy.
 *
 * The RateLimit-* headers are attached to the 429's own Response rather than
 * to c.res. An HTTPException builds its own response, and errorHandler() copies
 * headers off `err.res` - anything written to c.res beforehand is discarded, so
 * the previous implementation's headers never reached a rate-limited caller.
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

/**
 * The HTTP translation for a prompt that could not be expanded.
 */
function toResolvePromptHttpException(failure: ResolvePromptFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    // Only requests that actually name a prompt are held to this, so the
    // challenge names the scope rather than failing the whole endpoint.
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

    // 422 rather than 400: the body is well formed, and what is wrong is a
    // fact about the template it named. The names are listed because the
    // caller cannot see the template to work them out.
    case 'PROMPT_VARIABLES_MISSING':
      return new HTTPException(422, {
        message: `Prompt '${failure.name}' v${failure.version} requires variables that were not supplied: ${failure.missing.join(', ')}`,
      });

    default:
      return assertNever(code);
  }
}

/**
 * Expands a prompt reference into a leading system message.
 *
 * Returns a rewritten body rather than mutating: everything downstream - the
 * provider call, the log, the token accounting - should see one request, and
 * that request is the expanded one.
 *
 * Deliberately shaped as "resolve a reference into messages" rather than
 * "prepend a system message", so that a per-message reference, or a prompt
 * whose version carries a whole conversation, is a second call site here and
 * not a redesign.
 *
 * @param body
 * The validated request body, which may or may not name a prompt.
 *
 * @returns
 * The body to send upstream, and the version that was expanded when one was.
 *
 * @throws {HTTPException}
 * When the prompt cannot be resolved or rendered.
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
      const completion = await Services.createChatCompletion(headers, expanded.body, echoLogId);
      return c.json(completion, 200);
    }

    // The first chunk is pulled before streamSSE() takes over so that a
    // failure to even reach the provider is still a normal error response.
    // Once the stream opens, the 200 is committed and nothing can change it -
    // including the ai-log-id header, which is why the log has to be opened
    // before this point rather than when the stream finishes.
    const chunks = Services.streamChatCompletion(headers, expanded.body, echoLogId);
    const first = await chunks.next();

    return streamSSE(c, async (sse) => {
      if (!first.done) {
        await sse.writeSSE({ data: JSON.stringify(first.value) });
      }

      for await (const chunk of chunks) {
        await sse.writeSSE({ data: JSON.stringify(chunk) });
      }

      await sse.writeSSE({ data: '[DONE]' });
    });
  },
});

const app = new OpenAPIHono({
  defaultHook: zodExceptionHook,
}).openapiRoutes([createChatCompletion] as const);

export default app;
