import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { createCacheKey } from '@repo/core';
import { redis } from '@repo/redis';
import { type LanguageModelMiddleware, simulateReadableStream } from 'ai';

/**
 * Creates a caching middleware for chat completions. Works for both generate
 * and stream calls.
 *
 * Note that this is organization wide - not per-user.
 *
 * Basically just https://ai-sdk.dev/docs/advanced/caching
 *
 * @param namespace
 * The namespace to use for caching, typically including organization and model
 * info.
 *
 * @param cache
 * An object to track cache hits.
 *
 * @param options
 * Options for cache TTL and refresh behavior.
 *
 * @returns
 * An AI SDK middleware that can be used with the AI SDK to cache chat
 * completions.
 */
export function createCacheMiddleware(
  namespace: Record<string, unknown>,
  cache: { hit: boolean },
  options: { ttl?: number; refresh?: boolean } = {},
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = createCacheKey('chat-completions:generate:', { namespace, params });
      const cached = options.refresh ? null : await redis.get(key);

      // If we have a cache hit or are forcing a refresh.
      if (cached !== null) {
        cache.hit = true;

        const result = JSON.parse(cached) as Awaited<ReturnType<typeof doGenerate>>;
        if (result.response?.timestamp) {
          result.response.timestamp = new Date(result.response.timestamp);
        }

        return result;
      }

      // Cache miss (or forced refresh), need to regenerate.
      const result = await doGenerate();
      await redis.set(key, JSON.stringify(result), { expiration: { type: 'EX', value: options.ttl ?? 300 } });
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const key = createCacheKey('chat-completions:stream:', { namespace, params });
      const cached = options.refresh ? null : await redis.get(key);

      // If we have a cache hit or are forcing a refresh.
      if (cached !== null) {
        cache.hit = true;

        const chunks = JSON.parse(cached) as LanguageModelV4StreamPart[];
        for (const chunk of chunks) {
          if (chunk.type === 'response-metadata' && chunk.timestamp) {
            chunk.timestamp = new Date(chunk.timestamp);
          }
        }

        return {
          stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
        };
      }

      // Cache miss (or forced refresh), need to regenerate.
      const { stream, ...rest } = await doStream();
      const chunks: LanguageModelV4StreamPart[] = [];
      const capture = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(chunk, controller) {
          chunks.push(chunk);
          controller.enqueue(chunk);
        },

        async flush() {
          const finished = chunks.some((chunk) => chunk.type === 'finish' && chunk.finishReason.raw !== undefined);
          const error = chunks.some((chunk) => chunk.type === 'error');
          if (!finished || error) {
            return;
          }

          await redis.set(key, JSON.stringify(chunks), { expiration: { type: 'EX', value: options.ttl ?? 300 } });
        },
      });

      return { ...rest, stream: stream.pipeThrough(capture) };
    },
  };
}
