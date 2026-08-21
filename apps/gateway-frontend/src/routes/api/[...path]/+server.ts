import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { refreshSession, type Session } from '$lib/server/session';

/**
 * The gateway's own request/response controls, all spelled `ai-*`:
 * `ai-api-key` (the caller's UPSTREAM provider credential), `ai-base-url`,
 * the log and retry switches, and `ai-log-id` on the way back.
 *
 * Forwarded verbatim in both directions. They are not authentication - the
 * session bearer below is - so passing them through gives the browser nothing
 * the backend would not already grant this session on a direct call.
 */
const GATEWAY_HEADER_PREFIX = 'ai-';

// The BFF proxy: forwards /api/* to the backend's /v1/* with the session's
// bearer token attached. The browser never holds a token; the backend does
// all real authn/authz on every request.
const handler: RequestHandler = async ({ params, request, cookies, url, locals }) => {
  // hooks.server.ts resolved and renewed this already, and 401s the request
  // outright when there is no session.
  let session = locals.session;
  if (!session) {
    return json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
  }

  const backend = env.BACKEND_URL ?? 'http://localhost:3000';
  const target = `${backend}/v1/${params.path}${url.search}`;

  // Read once, reused across both attempts. A stream could only be consumed
  // by the first, which is what would otherwise make the retry below
  // impossible for anything carrying a body.
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();

  const forward = (accessToken: string) => {
    const headers = new Headers({ authorization: `Bearer ${accessToken}` });

    const contentType = request.headers.get('content-type');
    if (contentType) {
      headers.set('content-type', contentType);
    }

    // Header names are lower-cased by Headers, so the prefix test needs no
    // normalisation of its own.
    request.headers.forEach((value, name) => {
      if (name.startsWith(GATEWAY_HEADER_PREFIX)) {
        headers.set(name, value);
      }
    });

    return fetch(target, { method: request.method, headers: headers, body: body });
  };

  let response = await forward(session.accessToken);

  /**
   * The reactive half of renewal.
   *
   * Renewing ahead of expiry cannot see a token revoked at the IDP, a
   * deactivated user, a rotated JWKS, or a session evicted from Valkey - all of
   * which arrive here as a 401 on a token that looked valid moments ago.
   *
   * Re-sending is safe even for a POST because authenticate() is middleware
   * that throws before any handler runs, so a 401 is proof that nothing was
   * mutated. That is specifically NOT true of a 5xx or a timeout, which is why
   * only this one status is retried.
   *
   * Never on 403: that is authorize() saying the token is fine and the caller
   * lacks the scope, and a new token carries the same scopes. Retrying it would
   * loop without ever changing the answer.
   */
  if (response.status === 401 && session.refreshToken) {
    const renewed: Session | null = await refreshSession(cookies);

    if (renewed && renewed.accessToken !== session.accessToken) {
      session = renewed;
      response = await forward(renewed.accessToken);
    }
  }

  // Rebuilt rather than passed through wholesale: the backend's hop-by-hop and
  // transfer headers do not describe the response this handler is about to
  // send, and copying content-length in particular breaks a streamed body.
  const responseHeaders = new Headers({
    'content-type': response.headers.get('content-type') ?? 'application/json',
  });

  response.headers.forEach((value, name) => {
    if (name.startsWith(GATEWAY_HEADER_PREFIX)) {
      responseHeaders.set(name, value);
    }
  });

  // response.body is handed on unread, which is what keeps a text/event-stream
  // completion streaming to the browser rather than arriving in one piece once
  // the provider has finished.
  return new Response(response.status === 204 ? null : response.body, {
    status: response.status,
    headers: responseHeaders,
  });
};

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
