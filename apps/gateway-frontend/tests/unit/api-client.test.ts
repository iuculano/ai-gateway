import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { ApiError, client } from '../../src/lib/api/client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const location = { href: '/playground' };
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  location.href = '/playground';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('upstream 401 preserves the provider error without navigating away', async () => {
  fetchSpy.mockResolvedValue(
    Response.json(
      { error: { message: 'Upstream provider rejected the request: invalid api key' } },
      { status: 401, headers: { 'ai-error-source': 'upstream' } },
    ),
  );
  await expect(
    client.chat.completions.$post({
      header: { 'ai-api-key': 'invalid' },
      json: { model: 'openai/test', messages: [{ role: 'user', content: 'Hello' }] },
    }),
  ).rejects.toThrow('Upstream provider rejected the request: invalid api key');
  expect(location.href).toBe('/playground');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('gateway 401 still redirects to login', async () => {
  fetchSpy.mockResolvedValue(Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }));
  await expect(client.models.providers.$get({ query: {} })).rejects.toEqual(new ApiError(401, 'Session expired.'));
  expect(location.href).toBe('/auth/login');
});

test('the catalog loader follows provider cursors and combines pages', async () => {
  const { listAllProviders } = await import('../../src/lib/api/models');
  fetchSpy
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: 'anthropic', synced_at: null, models: [] }],
        meta: { oldest_id: 'anthropic', more_data: true },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: 'openai', synced_at: null, models: [] }],
        meta: { oldest_id: 'openai', more_data: false },
      }),
    );

  expect((await listAllProviders()).data.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('after_id=anthropic');
});
