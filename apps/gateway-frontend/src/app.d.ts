// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { Session } from '$lib/server/session';

declare global {
  namespace App {
    interface Locals {
      /**
       * Resolved once per request in hooks.server.ts, renewed if needed.
       *
       * Null means unauthenticated. Anything past the hook's own guard can rely
       * on this being set for a protected route.
       */
      session: Session | null;
    }
    // interface Error {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}
