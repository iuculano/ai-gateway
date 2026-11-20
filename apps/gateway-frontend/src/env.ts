import { defineEnvVars } from '@sveltejs/kit/env';

/** Lets a variable be left unset, which SvelteKit otherwise refuses to start without. */
function optional(value: string | undefined) {
  return value;
}

// Everything is optional on purpose. Defaults stay next to the code that reads
// them, and the two ZITADEL settings are checked on first use so the server can
// start without an identity provider, which the browser tests rely on.
export const variables = defineEnvVars({
  BACKEND_URL: { schema: optional },
  ZITADEL_ISSUER: { schema: optional },
  ZITADEL_CLIENT_ID: { schema: optional },
  OIDC_REFRESH_ENABLED: { schema: optional },
  POST_LOGOUT_REDIRECT_URI: { schema: optional },
  SESSION_IDLE_SECONDS: { schema: optional },
  SESSION_ABSOLUTE_SECONDS: { schema: optional },
});
