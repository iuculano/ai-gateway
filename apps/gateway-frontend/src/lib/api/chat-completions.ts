import type { ChatCompletionChunk } from 'gateway-backend/schemas/chat-completions';
import type { InferRequestType } from 'hono/client';
import { client } from './client';

type CreateChatCompletion = (typeof client)['chat']['completions']['$post'];
type CreateChatCompletionRequest = InferRequestType<CreateChatCompletion>;

/**
 * The gateway's `ai-*` controls.
 *
 * `ai-api-key` is required and is the caller's UPSTREAM provider credential -
 * a different secret from the one that authenticates to the gateway, which on
 * this path is the session the BFF proxy attaches. The gateway deliberately
 * holds no provider key of its own, so a request without this header cannot
 * reach a model.
 */
export type GatewayHeaders = CreateChatCompletionRequest['header'];

export type ChatCompletionRequest = CreateChatCompletionRequest['json'];
export type ChatCompletionMessage = ChatCompletionRequest['messages'][number];
export type ChatCompletionRole = ChatCompletionMessage['role'];

/**
 * A streamed frame.
 *
 * Typed from the backend's schema module rather than from the RPC client: the
 * route declares both application/json and text/event-stream on its 200 and
 * Hono's client types keep only the JSON one, so there is nothing to infer
 * this from on the response side.
 */
export type { ChatCompletionChunk };

/** Echoed by the gateway so a caller can find its own row on the logs page. */
const LOG_ID_HEADER = 'ai-log-id';

/** Frames are separated by a blank line. The CR form is legal and does occur. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

/** The sentinel the gateway writes as the last frame of every stream. */
const DONE = '[DONE]';

/**
 * Splits a response body into server-sent event frames, as raw text.
 *
 * EventSource cannot be used for any of this: it is GET-only and cannot set
 * headers, and this endpoint is a POST that needs `ai-api-key`.
 *
 * @param body
 * The streamed response body.
 *
 * @returns
 * Each frame, without its terminating blank line.
 */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();

  // One decoder across the whole body, fed with `stream: true`. A multi-byte
  // character can straddle two network chunks, and decoding each chunk on its
  // own would turn the halves into replacement characters.
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      for (let boundary = FRAME_BOUNDARY.exec(buffer); boundary; boundary = FRAME_BOUNDARY.exec(buffer)) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);

        if (frame.length > 0) {
          yield frame;
        }
      }
    }

    // Flush whatever the decoder was still holding, then emit a trailing frame
    // the server never terminated with a blank line.
    buffer += decoder.decode();

    if (buffer.trim().length > 0) {
      yield buffer;
    }
  } finally {
    // Abandoning the loop - the caller pressed stop, or a frame failed to
    // parse - suspends the generator here. Cancelling releases the connection
    // rather than leaving it open until the reader is collected.
    await reader.cancel().catch(() => {});
  }
}

/**
 * The `data:` payload of one frame, or null for a frame carrying none.
 *
 * @param frame
 * One frame's raw text, comment and field lines included.
 *
 * @returns
 * The payload, with multi-line data fields rejoined as the spec requires.
 */
function dataOf(frame: string): string | null {
  const lines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    // A single space after the colon is separator rather than content - that is
    // the spec, and it is what hono's streamSSE writes.
    .map((line) => line.slice('data:'.length).replace(/^ /, ''));

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * The frames of one stream, parsed.
 *
 * `raw` is handed back alongside the parsed chunk because the playground shows
 * the wire form as well as the assembled message, and re-serialising the chunk
 * would not be the same text.
 */
export interface StreamedChunk {
  chunk: ChatCompletionChunk;
  raw: string;
}

async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamedChunk> {
  let terminated = false;

  for await (const frame of readFrames(body)) {
    const data = dataOf(frame);
    if (data === null) continue;

    if (data === DONE) {
      terminated = true;
      break;
    }

    yield { chunk: JSON.parse(data) as ChatCompletionChunk, raw: data };
  }

  // [DONE] is the last thing the gateway writes. Reaching the end of the body
  // without it means the connection dropped, or the provider failed after the
  // 200 was already committed and could no longer be turned into an error
  // response. The frames received are real, but the answer is not finished -
  // accepting it silently would render a truncated reply as though the model
  // had chosen to stop there.
  if (!terminated) {
    throw new Error('The stream ended before the completion finished.');
  }
}

/**
 * Generates a completion and waits for the whole thing.
 *
 * @param headers
 * The gateway's `ai-*` controls, including the upstream credential.
 *
 * @param body
 * The request. `stream` is overridden - use streamChatCompletion() instead.
 *
 * @param signal
 * Aborts the request.
 *
 * @returns
 * The completion, and the log id the gateway echoed for it.
 */
export async function createChatCompletion(headers: GatewayHeaders, body: ChatCompletionRequest, signal?: AbortSignal) {
  const response = await client.chat.completions.$post(
    { header: headers, json: { ...body, stream: false } },
    { init: { signal: signal } },
  );

  const payload = await response.json();

  // The route declares application/json AND text/event-stream on the same 200,
  // so the client types this body as either shape. Only the completion can
  // arrive on a request that did not ask to stream, and `object` is the
  // discriminant that says so - narrowing on it here keeps every caller from
  // having to handle a frame that cannot reach them.
  if (payload.object !== 'chat.completion') {
    throw new Error('The gateway answered a non-streamed request with a stream frame.');
  }

  return {
    logId: response.headers.get(LOG_ID_HEADER),
    completion: payload,
  };
}

/**
 * Opens a streamed completion.
 *
 * Resolves once the gateway has answered, which is the point at which a request
 * that never reached the provider is still a normal error. Everything after
 * that arrives through `chunks`.
 *
 * @param headers
 * The gateway's `ai-*` controls, including the upstream credential.
 *
 * @param body
 * The request. `stream` and `stream_options` are overridden.
 *
 * @param signal
 * Aborts the request, and the stream with it.
 *
 * @returns
 * The log id, and the frames as they arrive.
 */
export async function streamChatCompletion(headers: GatewayHeaders, body: ChatCompletionRequest, signal?: AbortSignal) {
  const response = await client.chat.completions.$post(
    {
      header: headers,
      // include_usage is what makes token counts arrive on this path at all:
      // without it the gateway's last frame is the finish reason and the usage
      // frame behind it is never emitted.
      json: { ...body, stream: true, stream_options: { include_usage: true } },
    },
    { init: { signal: signal } },
  );

  if (!response.body) {
    throw new Error('The gateway accepted the request but returned no stream.');
  }

  return {
    logId: response.headers.get(LOG_ID_HEADER),
    chunks: readChunks(response.body),
  };
}
