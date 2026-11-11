import { OpenAPIHono } from '@hono/zod-openapi';
import { zodExceptionHook } from '@repo/hono';
import Routes from './analytics.routes';
import Services from './analytics.services';

const app = new OpenAPIHono({ defaultHook: zodExceptionHook })

  /**
   * POST /analytics/series
   * Time series and breakdowns, served from ClickHouse.
   */
  .openapi(Routes.postAnalyticsSeries, async (c) => {
    const body = c.req.valid('json');
    const series = await Services.queryAnalyticsSeries(body);

    return c.json(series, 200);
  })

  /**
   * POST /analytics/users
   * A page of users, and how many there are.
   */
  .openapi(Routes.postAnalyticsUsers, async (c) => {
    const body = c.req.valid('json');
    const users = await Services.queryAnalyticsUsers(body);

    return c.json(users, 200);
  })

  /**
   * POST /analytics/sessions
   * Session count and a page of sessions, by spend, requests or length.
   */
  .openapi(Routes.postAnalyticsSessions, async (c) => {
    const body = c.req.valid('json');
    const sessions = await Services.queryAnalyticsSessions(body);

    return c.json(sessions, 200);
  })

  /**
   * POST /analytics/session-distribution
   * How spend, length and request counts spread across sessions.
   */
  .openapi(Routes.postAnalyticsSessionDistribution, async (c) => {
    const body = c.req.valid('json');
    const distribution = await Services.queryAnalyticsSessionDistribution(body);

    return c.json(distribution, 200);
  })

  /**
   * POST /analytics/session-positions
   * What the nth request of a session costs and sends.
   */
  .openapi(Routes.postAnalyticsSessionPositions, async (c) => {
    const body = c.req.valid('json');
    const positions = await Services.queryAnalyticsSessionPositions(body);

    return c.json(positions, 200);
  })

  /**
   * POST /analytics/tokens
   * Tokens in, out and from the prompt cache, and how big requests and answers are.
   */
  .openapi(Routes.postAnalyticsTokens, async (c) => {
    const body = c.req.valid('json');
    const tokens = await Services.queryAnalyticsTokens(body);

    return c.json(tokens, 200);
  });

export default app;
