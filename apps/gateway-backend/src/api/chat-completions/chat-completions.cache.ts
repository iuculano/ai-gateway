import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { createCacheKey } from '@repo/core';
import { redis } from '@repo/redis';
import { type LanguageModelMiddleware, simulateReadableStream } from 'ai';

export function createCacheMiddleware(
  scope: string,
  cache: { hit: boolean },
  { ttl = 300, refresh = false }: { ttl?: number; refresh?: boolean } = {},
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = createCacheKey('chat-completions:generate:', { scope, params });
      const cached = refresh ? null : await redis.get(key);

      if (cached !== null) {
        cache.hit = true;
        const result = JSON.parse(cached) as Awaited<ReturnType<typeof doGenerate>>;
        if (result.response?.timestamp) {
          result.response.timestamp = new Date(result.response.timestamp);
        }
        return result;
      }

      const result = await doGenerate();
      await redis.set(key, JSON.stringify(result), { expiration: { type: 'EX', value: ttl } });
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const key = createCacheKey('chat-completions:stream:', { scope, params });
      const cached = refresh ? null : await redis.get(key);

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

      const { stream, ...rest } = await doStream();
      const chunks: LanguageModelV4StreamPart[] = [];
      const capture = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(chunk, controller) {
          chunks.push(chunk);
          controller.enqueue(chunk);
        },
        async flush() {
          await redis.set(key, JSON.stringify(chunks), { expiration: { type: 'EX', value: ttl } });
        },
      });

      return { ...rest, stream: stream.pipeThrough(capture) };
    },
  };
}
