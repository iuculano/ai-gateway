import { refreshSession } from '#lib/server/session.ts';
import { BACKEND_URL } from '$app/env/private';
import type { RequestEvent } from './$types';

// Where this route is mounted, which is swapped for the backend's /v1.
const API_PREFIX = '/api';

// The gateway's own controls are all spelled `ai-*`, from the caller's provider
// key to the correlation ids on the way back. They are not authentication, so
// passing them through gives the browser nothing the backend would not grant
// this session on a direct call.
const GATEWAY_HEADER_PREFIX = 'ai-';

// What else goes on from the browser's request. The trace headers let browser
// instrumentation join its trace to the gateway's, and the user agent is what
// the backend's audit log shows for who did something.
const FORWARDED_HEADERS = new Set(['content-type', 'user-agent', 'traceparent', 'tracestate']);

/**
 * The headers that go on to the backend, before a session's token is added.
 */
function forwardedHeaders(request: Request, clientAddress: string | undefined): Headers {
  const headers = new Headers();

  // Names arrive lower-cased, so the comparisons need no normalising.
  for (const [name, value] of request.headers) {
    if (FORWARDED_HEADERS.has(name) || name.startsWith(GATEWAY_HEADER_PREFIX)) {
      headers.set(name, value);
    }
  }

  // Set from the connection and never copied from the request, so that a
  // browser cannot name its own address. The backend takes it only from a peer
  // on its list of trusted proxies.
  if (clientAddress) {
    headers.set('x-forwarded-for', clientAddress);
  }

  return headers;
}

/**
 * A copy of the headers with a session's access token added.
 */
function authorized(headers: Headers, accessToken: string): Headers {
  const copy = new Headers(headers);
  copy.set('authorization', `Bearer ${accessToken}`);

  return copy;
}

/**
 * Forwards /api/* to the backend's /v1/* with the session's token attached, so
 * that the browser never holds one.
 */
async function proxy({ request, cookies, url, locals, getClientAddress }: RequestEvent): Promise<Response> {
  const session = locals.session;

  if (!session) {
    return Response.json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
  }

  // The path goes on as it was asked for, still encoded. Rebuilt from the
  // decoded route parameter, a `..%2F` in it would climb out of /v1 to whatever
  // else the backend serves.
  const backend = BACKEND_URL ?? 'http://localhost:8080';
  const target = `${backend}/v1${url.pathname.slice(API_PREFIX.length)}${url.search}`;

  // Read once, because a stream could not be sent again on the retry below.
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const forwarded = forwardedHeaders(request, getClientAddress());
  const init = { method: request.method, body: body };

  let response = await fetch(target, { ...init, headers: authorized(forwarded, session.accessToken) });

  // Renewing ahead of expiry cannot see a token revoked at the identity
  // provider or a signing key that was rotated. Those arrive here, as a 401 on
  // a token that looked valid a moment ago.
  //
  // Only the gateway's own refusal is retried. A provider's 401 is marked as
  // upstream, and by then the request has run, so a retry would replay a failed
  // inference. A 403 is never retried either, because a new token carries the
  // same scopes.
  if (response.status === 401 && response.headers.get('ai-error-source') !== 'upstream' && session.refreshToken) {
    const renewed = await refreshSession(cookies);

    if (renewed && renewed.accessToken !== session.accessToken) {
      response = await fetch(target, { ...init, headers: authorized(forwarded, renewed.accessToken) });
    }
  }

  // Rebuilt and not passed through whole. The backend's transfer headers do not
  // describe the response sent from here, and a copied content-length breaks a
  // streamed body.
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });

  for (const [name, value] of response.headers) {
    if (name.startsWith(GATEWAY_HEADER_PREFIX)) {
      headers.set(name, value);
    }
  }

  // The body is handed on unread, which keeps a completion streaming to the
  // browser as it is produced.
  return new Response(response.status === 204 ? null : response.body, { status: response.status, headers: headers });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
