import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '../../src/lib/server/session';

const SESSION: Session = {
  accessToken: 'session-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  user: {},
};

// The address the browser's connection came from.
const CLIENT_ADDRESS = '198.51.100.20';

const refreshSession = mock(async (): Promise<Session | null> => ({ ...SESSION, accessToken: 'renewed-token' }));

// Must precede the import below, because the proxy reads both modules as it
// loads.
mock.module('$app/env/private', () => ({ BACKEND_URL: 'http://backend.test' }));
mock.module(new URL('../../src/lib/server/session.ts', import.meta.url).pathname, () => ({ refreshSession }));

const { POST } = await import('../../src/routes/api/[...path]/+server');

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  refreshSession.mockClear();
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

interface Sent {
  session?: Session | null;
  headers?: Record<string, string>;
  path?: string;
}

async function send({
  session = SESSION,
  headers = {},
  path = '/api/chat/completions?verbose=true',
}: Sent = {}): Promise<Response> {
  const url = new URL(path, 'http://frontend.test');
  const request = new Request(url, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
    headers: { 'content-type': 'application/json', ...headers },
  });

  const event = {
    // Decoded, which is how SvelteKit hands a route parameter over.
    params: { path: decodeURIComponent(url.pathname.slice('/api/'.length)) },
    request: request,
    url: url,
    locals: { session: session },
    cookies: {},
    getClientAddress: () => CLIENT_ADDRESS,
  };

  return POST(event as unknown as Parameters<typeof POST>[0]);
}

function forwardedHeaders(call: number): Headers {
  return new Headers(fetchSpy.mock.calls[call]?.[1]?.headers);
}

// Forwarding

test('a request without a session is refused before it reaches the backend', async () => {
  const response = await send({ session: null });

  expect(response.status).toBe(401);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a request is forwarded under /v1 with the session token and its query', async () => {
  fetchSpy.mockResolvedValue(Response.json({ ok: true }));

  const response = await send();

  expect(response.status).toBe(200);
  expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('http://backend.test/v1/chat/completions?verbose=true');
  expect(forwardedHeaders(0).get('authorization')).toBe('Bearer session-token');
});

test('a path that tries to climb out of /v1 is forwarded as it was asked for', async () => {
  fetchSpy.mockResolvedValue(Response.json({ ok: true }));

  // Decoded, this is ../metrics, which the backend serves outside its API and
  // without asking who is calling.
  await send({ path: '/api/..%2Fmetrics' });

  expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('http://backend.test/v1/..%2Fmetrics');
});

test('the gateway, trace and user agent headers are forwarded, and nothing else', async () => {
  fetchSpy.mockResolvedValue(Response.json({ ok: true }));

  await send({
    headers: {
      'ai-api-key': 'provider-key',
      traceparent: '00-trace-span-01',
      'user-agent': 'Browser/1.0',
      cookie: 'relay_session=secret',
      'x-custom': 'anything',
    },
  });

  const headers = forwardedHeaders(0);
  expect(headers.get('ai-api-key')).toBe('provider-key');
  expect(headers.get('traceparent')).toBe('00-trace-span-01');
  expect(headers.get('content-type')).toBe('application/json');

  // What the backend's audit log shows for who did something.
  expect(headers.get('user-agent')).toBe('Browser/1.0');

  // The session cookie stays with the BFF. The backend only ever sees the
  // token.
  expect(headers.has('cookie')).toBe(false);
  expect(headers.has('x-custom')).toBe(false);
});

test('the backend is told the address the browser connected from, whatever the request claims', async () => {
  fetchSpy.mockResolvedValue(Response.json({ ok: true }));

  await send({ headers: { 'x-forwarded-for': '203.0.113.7' } });

  expect(forwardedHeaders(0).get('x-forwarded-for')).toBe(CLIENT_ADDRESS);
});

test('only gateway headers come back from the backend', async () => {
  const upstream = Response.json(
    { ok: true },
    { headers: { 'ai-trace-id': 'trace-1', 'set-cookie': 'backend=1', 'x-internal': 'yes' } },
  );
  fetchSpy.mockResolvedValue(upstream);

  const response = await send();

  expect(response.headers.get('ai-trace-id')).toBe('trace-1');
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.has('x-internal')).toBe(false);
});

// Session renewal

test('a gateway 401 refreshes the session and retries with the new token', async () => {
  fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
  fetchSpy.mockResolvedValueOnce(Response.json({ ok: true }));

  const response = await send();

  expect(response.status).toBe(200);
  expect(refreshSession).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(forwardedHeaders(1).get('authorization')).toBe('Bearer renewed-token');
});

test('a gateway 401 is passed on when the session cannot be renewed', async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 401 }));
  refreshSession.mockResolvedValueOnce(null);

  const response = await send();

  expect(response.status).toBe(401);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('an upstream 401 passes through without refreshing or replaying the inference', async () => {
  // The provider refused its own key after the gateway accepted ours, so a
  // retry would run the same failed inference twice.
  const upstream = Response.json(
    { error: { message: 'Invalid provider key' } },
    { status: 401, headers: { 'ai-error-source': 'upstream' } },
  );
  fetchSpy.mockResolvedValue(upstream);

  const response = await send();

  expect(response.status).toBe(401);
  expect(response.headers.get('ai-error-source')).toBe('upstream');
  expect(await response.json()).toEqual({ error: { message: 'Invalid provider key' } });
  expect(refreshSession).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
