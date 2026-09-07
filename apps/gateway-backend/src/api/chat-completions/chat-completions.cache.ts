import { createCacheKey } from '@repo/core';
import { redis } from '@repo/redis';
import type { LanguageModelMiddleware } from 'ai';

// Need to figure out what to do with this, because this will be shared logic
// with the responses api at some point...
export function createCacheMiddleware(scope: string): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = createCacheKey('chat-completions:responses:', { scope, params });
      const cached = await redis.get(key);

      if (cached !== null) {
        const result = JSON.parse(cached) as Awaited<ReturnType<typeof doGenerate>>;
        if (result.response?.timestamp) {
          result.response.timestamp = new Date(result.response.timestamp);
        }
        return result;
      }

      const result = await doGenerate();
      await redis.set(key, JSON.stringify(result));
      return result;
    },
  };
}
