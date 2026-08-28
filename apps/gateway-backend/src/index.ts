import { OpenAPIHono } from '@hono/zod-openapi';
import { createGenericKeyAdapter, createZitadelAdapter } from '@repo/auth';
import { authenticate, callerContext, errorHandler, exposeMetrics, requestLogger, requestMetrics } from '@repo/hono';
import { createObjectStorage } from '@repo/object-storage';
import { connectRedis } from '@repo/redis';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import healthHandlers from './api/health/health.handlers';
import { ROLE_SCOPES_MAP } from './authorization';
import { environment } from './environment';
import { apiRoutes } from './routes';

export const app = new OpenAPIHono();

createObjectStorage({
  bucket: environment.S3_BUCKET,
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  accessKeyId: environment.S3_ACCESS_KEY_ID,
  secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
});

await connectRedis();

// Be mindful of the order of these middleware - it matters. Don't change it
// unless you know what you're doing.
app.onError(errorHandler());
app.use('*', secureHeaders());
app.use('*', requestId());
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
    jwtAdapter: await createZitadelAdapter({
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
//
// This should come last in the middleware chain, it relies on information
// from the previous middleware.
app.use('/v1/*', callerContext());

// Note, this being method-chained is very intentional here!  We need to
// preserve the type of the entire route tree in AppType for the typed Hono
// client to work. The frontend relies on this!
const routes = app
  .route('/', healthHandlers) // internal health check routes
  .route('/v1', apiRoutes); // public, versioned API routes

export type AppType = typeof routes;
export default routes;
