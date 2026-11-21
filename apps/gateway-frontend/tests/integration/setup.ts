import { mock } from 'bun:test';

// Makes the server's modules importable outside a SvelteKit build. `$app/env`
// and `$app/env/private` are virtual modules that only exist once Vite has
// resolved them, so stubbing them is what lets these tests run the real session
// and OIDC modules and not stand-ins for them.
//
// There is one export for each variable declared in src/env.ts, because a name
// that a module imports and this stub lacks fails the import outright.
mock.module('$app/env/private', () => ({
  BACKEND_URL: undefined,
  ZITADEL_ISSUER: 'https://idp.test',
  ZITADEL_CLIENT_ID: 'test-client',
  OIDC_REFRESH_ENABLED: 'true',
  POST_LOGOUT_REDIRECT_URI: undefined,
  SESSION_IDLE_SECONDS: '3600',
  SESSION_ABSOLUTE_SECONDS: '86400',
}));

mock.module('$app/env', () => ({ dev: true, browser: false, building: false }));

if (!process.env.REDIS_FRONTEND_TEST_URL) {
  throw new Error(
    'Missing REDIS_FRONTEND_TEST_URL. Point it at a logical database of its own, for example ' +
      'redis://host.docker.internal:6379/13.',
  );
}

// A database of its own, and not the one REDIS_TEST_URL names. Turbo runs the
// packages' integration tasks side by side and this suite deletes the keys it
// made, so sharing one with the backend suite would delete keys out from under
// it mid-run.
process.env.REDIS_URL = process.env.REDIS_FRONTEND_TEST_URL;
