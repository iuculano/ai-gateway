import { OpenAPIHono } from '@hono/zod-openapi';
import { createGenericKeyAdapter, createZitadelAdapter } from '@repo/auth';
import {
  authenticate,
  callerContext,
  errorHandler,
  exposeMetrics,
  requestLogger,
  requestMetrics,
} from '@repo/hono';
import { connectRedis } from '@repo/redis';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { ROLE_SCOPES_MAP } from './authorization';
import { environment } from './environment';
import { apiRoutes } from './routes';

export const app = new OpenAPIHono();

await connectRedis();

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT or API key',
  description: 'A Zitadel JWT or an opaque aik_ API key',
});

app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());

// Must be ahead of requestLogger() so the histogram spans the logging work too.
// The labels it records come from c.req.routePath, which only resolves to the
// matched route after the handler has run - so this must wrap the chain
// rather than sit at the end of it.
app.use('*', requestMetrics());

app.use('*', requestLogger());
app.get('/metrics', exposeMetrics());

app.doc31('/open-api.json', {
  openapi: '3.1.0',
  info: {
    version: '1.0.0',
    title: 'gateway-api',
  },
});

app.use(
  '/v1/*',
  authenticate({
    jwtAdapter: createZitadelAdapter({
      roleScopesMap: ROLE_SCOPES_MAP,
      issuer: environment.IDENTITY_PROVIDER_TOKEN_ISSUER,
      audience: environment.IDENTITY_PROVIDER_TOKEN_AUDIENCE,
    }),

    keyAdapter: createGenericKeyAdapter({
      keyPattern: /^aik_[a-zA-Z0-9]{60}$/,
    }),
  }),
);

// Binds the authenticated Caller to the request's asynchronous flow. Services
// can call getCaller() instead of receiving it through every function.
app.use('/v1/*', callerContext());

const routes = app.route('/', healthHandlers).route('/v1', apiRoutes);

export type AppType = typeof routes;
export default routes;
