import { mock } from 'bun:test';

/**
 * Makes the BFF's server modules importable outside a SvelteKit build.
 *
 * `$env/dynamic/private` and `$app/environment` are virtual modules that only
 * exist once Vite has resolved them, so anything importing session.ts or
 * oidc.ts is unloadable in a bare test process. Stubbing them here is what lets
 * these tests exercise the REAL session module rather than a reimplementation
 * of it - which matters, because the behaviour under test is concurrency
 * coordination, and a reimplementation would coordinate its own bugs.
 */
mock.module('$env/dynamic/private', () => ({
  env: {
    ZITADEL_ISSUER: 'https://idp.test',
    ZITADEL_CLIENT_ID: 'test-client',
    OIDC_REFRESH_ENABLED: 'true',
    SESSION_IDLE_SECONDS: '3600',
    SESSION_ABSOLUTE_SECONDS: '86400',
    REDIS_URL: process.env.REDIS_TEST_URL,
  },
}));

mock.module('$app/environment', () => ({ dev: true, browser: false, building: false }));

if (!process.env.REDIS_TEST_URL) {
  throw new Error(
    'Missing REDIS_TEST_URL. Point it at a dedicated logical database, for example ' +
      'redis://host.docker.internal:6379/13.',
  );
}

process.env.REDIS_URL = process.env.REDIS_TEST_URL;
