import type { RequestEvent } from '@sveltejs/kit';
import type { ApiType, HealthApiType, InternalApiType } from 'gateway-backend/routes';
import { hc } from 'hono/client';
import { env } from '$env/dynamic/private';
import { refreshSession, type Session } from './session';

/** Create per-request clients. Never share a user's session across requests. */
export function createBackendClients(event: Pick<RequestEvent, 'locals' | 'cookies'>) {
  const backend = (env.BACKEND_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  let session = event.locals.session;
  let refreshing: Promise<Session | null> | undefined;

  // Return ordinary HTTP responses so Hono retains its status-based response
  // types. Only authentication failures trigger a retry, never 403s or 5xxs.
  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!session) {
      return Response.json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
    }

    const request = new Request(input, init);
    const accessToken = session.accessToken;
    const forward = (token: string) => {
      const attempt = request.clone();
      attempt.headers.set('authorization', `Bearer ${token}`);
      return fetch(attempt);
    };

    let response = await forward(accessToken);
    if (response.status === 401 && session.refreshToken) {
      // Share renewal across simultaneous calls from these clients. A call
      // that finished later can reuse the token another call already renewed.
      if (session.accessToken === accessToken) {
        refreshing ??= refreshSession(event.cookies);
        const renewed = await refreshing;
        if (renewed) {
          session = renewed;
          event.locals.session = renewed;
        }
      }
      if (session.accessToken !== accessToken) {
        await response.body?.cancel();
        response = await forward(session.accessToken);
      }
    }
    return response;
  };

  return {
    api: hc<ApiType>(`${backend}/v1`, { fetch: authenticatedFetch }),
    internal: hc<InternalApiType>(`${backend}/v1/internal`, { fetch: authenticatedFetch }),
    health: hc<HealthApiType>(backend),
  };
}
