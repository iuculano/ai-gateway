import { defineOpenAPIRoute, OpenAPIHono } from '@hono/zod-openapi';
import { assertNever } from '@repo/core';
import { getLogger, keepAlive, writeFrame, zodExceptionHook } from '@repo/hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { toProviderHttpException } from '../../lib/ai-sdk-providers';
import { openAIErrorHandler, toOpenAIError } from '../../lib/openai-errors';
import PromptServices, { type ResolvePromptFailure } from '../prompts/prompts.services';
import Routes from './chat-completions.routes';
import type { ChatCompletionBody } from './chat-completions.schemas';
import Services, {
  type CreateChatCompletionFailure,
  type StreamChatCompletionFailure,
} from './chat-completions.services';

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

export function toChatCompletionHttpException(
  failure: CreateChatCompletionFailure | StreamChatCompletionFailure,
): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'UNKNOWN_TOOL_CALL':
      return new HTTPException(400, {
        message:
          `Tool message references tool_call_id '${failure.tool_call_id}', which no ` +
          'preceding assistant message issued',
      });

    case 'WEBHOOK_NOT_FOUND':
      return new HTTPException(404, {
        message: `No webhook with id '${failure.id}'`,
      });

    case 'MODEL_INVALID_ROUTING':
    case 'MODEL_NOT_FOUND':
    case 'MODEL_UNSUPPORTED_PROVIDER':
    case 'PROVIDER_INVALID_REQUEST':
    case 'PROVIDER_REJECTED_REQUEST':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
    case 'INTERNAL_ERROR':
      return toProviderHttpException(failure);

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
  // Return as is if no prompt is specified.
  if (!body.prompt) {
    return { body, version: null };
  }

  const resolved = await PromptServices.resolvePrompt(body.prompt);
  if (resolved.isErr()) {
    throw toResolvePromptHttpException(resolved.error);
  }

  // Add a reference to the resolved prompt, and inject it innto the system
  // message.
  return {
    body: {
      ...body,
      prompt: { ...body.prompt, version: resolved.value.version },
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

    // If a prompt is specified, expand it into the system message.
    const expanded = await expandPrompt(body);

    if (!expanded.body.stream) {
      const result = await Services.createChatCompletion(headers, expanded.body, c.req.raw.signal);

      return result.match(
        (completion) => c.json(completion, 200),
        (failure) => {
          throw toChatCompletionHttpException(failure);
        },
      );
    }

    // Need to read at least one chunk to infer a status. Otherwise, once
    // the SSE stream starts, we've already committed to a 200 status.
    const chunks = Services.streamChatCompletion(headers, expanded.body, c.req.raw.signal);
    const first = await chunks.next();

    if (!first.done && first.value.isErr()) {
      throw toChatCompletionHttpException(first.value.error);
    }

    return streamSSE(c, async (sse) => {
      const pings = keepAlive(sse);
      try {
        // Already taken from above, so the loop below starts at the second.
        if (!first.done && first.value.isOk()) {
          await writeFrame(sse, { data: JSON.stringify(first.value.value) });
        }

        for await (const result of chunks) {
          if (result.isErr()) {
            // OpenAI's SDKs raise on an error frame, rather than treating the
            // cut-off answer as complete.
            const exception = toChatCompletionHttpException(result.error);
            const error = toOpenAIError(exception.status, exception.message, exception.cause);
            await writeFrame(sse, { data: JSON.stringify(error) });
            return;
          }

          await writeFrame(sse, { data: JSON.stringify(result.value) });
        }

        await writeFrame(sse, { data: '[DONE]' });
      } catch (error) {
        // We've sent 200, now an error frame is the only way left to say
        // something has gone wrong.
        //
        // Without one the stream just ends, and OpenAI's SDKs read that as a
        // finished answer.
        getLogger().error({ err: error }, 'Chat completion stream failed after it opened');
        await writeFrame(sse, { data: JSON.stringify(toOpenAIError(500, 'Internal server error', undefined)) });
      } finally {
        clearInterval(pings);
      }
    });
  },
});

const app = new OpenAPIHono({
  defaultHook: zodExceptionHook,
}).openapiRoutes([createChatCompletion] as const);

// Adapter our error handling to OpenAI's expected format.
app.onError(openAIErrorHandler());

export default app;
