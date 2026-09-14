import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '../../src/lib/server/session';

const session: Session = {
  accessToken: 'session-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  user: {},
};
const refreshSession = mock(async () => ({ ...session, accessToken: 'renewed-token' }));
mock.module('$env/dynamic/private', () => ({ env: { BACKEND_URL: 'http://backend.test' } }));
mock.module(new URL('../../src/lib/server/session.ts', import.meta.url).pathname, () => ({ refreshSession }));
const { POST } = await import('../../src/routes/api/[...path]/+server');
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  refreshSession.mockClear();
  fetchSpy = spyOn(globalThis, 'fetch');
});
afterEach(() => fetchSpy.mockRestore());

function request() {
  return POST({
    params: { path: 'chat/completions' },
    request: new Request('http://frontend.test/api/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
      headers: { 'content-type': 'application/json', 'ai-api-key': 'invalid' },
    }),
    url: new URL('http://frontend.test/api/chat/completions'),
    locals: { session },
    cookies: {},
  } as unknown as Parameters<typeof POST>[0]);
}

test('upstream 401 passes through without refreshing or replaying the inference', async () => {
  fetchSpy.mockResolvedValue(
    Response.json(
      { error: { message: 'Invalid provider key' } },
      {
        status: 401,
        headers: { 'ai-error-source': 'upstream' },
      },
    ),
  );
  const response = await request();
  expect(response.status).toBe(401);
  expect(response.headers.get('ai-error-source')).toBe('upstream');
  expect(await response.json()).toEqual({ error: { message: 'Invalid provider key' } });
  expect(refreshSession).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('gateway 401 refreshes the session and retries with the new token', async () => {
  fetchSpy.mockResolvedValueOnce(new Response(null, { status: 401 }));
  fetchSpy.mockResolvedValueOnce(Response.json({ ok: true }));
  expect((await request()).status).toBe(200);
  expect(refreshSession).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  const headers = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer renewed-token');
});
