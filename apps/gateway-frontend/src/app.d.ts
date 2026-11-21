import type { Session } from '#lib/server/session.ts';

declare global {
  namespace App {
    interface Locals {
      /**
       * Resolved once per request in hooks.server.ts, and renewed there if it
       * needs it. Null means nobody is signed in, which the hook only lets
       * through on a public route.
       */
      session: Session | null;
    }
  }
}
