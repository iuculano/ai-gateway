import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { readSession } from '$lib/server/session';

// The BFF proxy: forwards /api/* to the backend's /v1/* with the session's
// bearer token attached. The browser never holds a token; the backend does
// all real authn/authz on every request.
const handler: RequestHandler = async ({ params, request, cookies, url }) => {
  const session = await readSession(cookies);
  if (!session) {
    return json({ error: { code: 401, message: 'Not authenticated.' } }, { status: 401 });
  }

  const backend = env.BACKEND_URL ?? 'http://localhost:3000';
  const target = `${backend}/v1/${params.path}${url.search}`;

  const headers = new Headers({
    authorization: `Bearer ${session.accessToken}`,
  });
  const contentType = request.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }

  const response = await fetch(target, {
    method: request.method,
    headers: headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  });

  return new Response(response.status === 204 ? null : response.body, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    },
  });
};

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
