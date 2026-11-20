import type { SSEMessage, SSEStreamingApi } from 'hono/streaming';

/**
 * Writes a frame unless the caller has gone. The stream is read to the end
 * either way, so the provider's usage and cost still get recorded.
 *
 * @param sse
 * The open stream.
 *
 * @param message
 * The frame to write.
 */
export async function writeFrame(sse: SSEStreamingApi, message: SSEMessage): Promise<void> {
  if (sse.aborted) {
    return;
  }

  try {
    await sse.writeSSE(message);
  } catch {
    // The caller left between the check and the write.
  }
}

// How often a quiet stream sends a comment frame, which clients ignore. It
// keeps proxies with their own idle limits from dropping the connection, and
// has to stay under Bun's ten second idle timeout or Bun closes the stream itself.
const KEEP_ALIVE_MS = 5_000;

/**
 * Starts sending keep-alive comments on a stream. Clear the timer when the
 * stream ends.
 *
 * @param sse
 * The open stream.
 *
 * @param ms
 * How long between comments.
 */
export function keepAlive(sse: SSEStreamingApi, ms = KEEP_ALIVE_MS): Timer {
  return setInterval(() => {
    if (!sse.aborted) {
      sse.write(': keep-alive\n\n').catch(() => {});
    }
  }, ms);
}
