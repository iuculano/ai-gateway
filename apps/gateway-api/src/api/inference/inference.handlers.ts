import { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from 'hono/bun'
import { enforceRateLimit, parseRateLimitHeader } from '@lib/rate-limiter';
import { HTTPException } from 'hono/http-exception';
import Routes from './inference.routes';
import Services from './inference.services';
import { zodExceptionHook } from '../../middleware/error-handler';


const app = new OpenAPIHono({ defaultHook: zodExceptionHook });

app.openapi(Routes.postInference, async (c) => {
  const headers = c.req.valid('header');
  const json = c.req.valid('json');

  if (headers['ai-rate-limit-policy']) {
    // We can technically rate limit by anything unique but currently just
    // support the client IP address.
    //
    // Maybe supporting API keys or user IDs will be useful in the future?
    const key = getConnInfo(c).remote.address;
    if (!key) {
      throw new HTTPException(503, {
        message: 'Unable to determine client IP for rate limiting',
      });
    }

    // Bash the header into an object describing the rate limit config.
    // Generally, this should never fail because the header is validated...
    const config = await parseRateLimitHeader(headers['ai-rate-limit-policy']);
    if (!config) {
      throw new HTTPException(400, {
        message: 'Malformed rate limit policy header format',
      });
    }

    const result = await enforceRateLimit(
      key,
      config
    );

    // Set both the standard and legacy rate limit headers.
    // The X- headers still seem wildly more common...
    c.res.headers.append('RateLimit-Limit', result.consumedQuota.toString());
    c.res.headers.append('RateLimit-Remaining', result.remainingQuota.toString());
    c.res.headers.append('RateLimit-Reset', result.secondsUntilReset.toString());
    c.res.headers.append('X-RateLimit-Limit', result.consumedQuota.toString());
    c.res.headers.append('X-RateLimit-Remaining', result.remainingQuota.toString());
    c.res.headers.append('X-RateLimit-Reset', result.secondsUntilReset.toString());

    if (result.isLimited) {
      c.res.headers.append('Retry-After', result.secondsUntilReset.toString());

      throw new HTTPException(429, {
        message: `Rate limit exceeded. Try again in ${result.secondsUntilReset} seconds.`,
      });
    }
  }

  if (!json.stream) {
    const result = await Services.submitInference(headers, json);
    return c.json(result, 200);
  }

  else {
    const stream = await Services.submitInferenceStreaming(headers, json);

    return streamSSE(c, async sse => {
      for await (const chunk of stream) {
        await sse.writeSSE({ data: chunk });
      }

      await sse.writeSSE({ data: '[DONE]' });
    });
  }
});

export default app;
