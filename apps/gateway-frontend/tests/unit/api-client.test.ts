import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { ApiError, client } from '../../src/lib/api/client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const location = { href: '/playground', pathname: '/playground', search: '?from=log-1' };

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  location.href = '/playground';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });

  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();

  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

/**
 * Any request through the client, for tests about how it treats the response.
 */
function listProviders(): ReturnType<typeof client.models.providers.$get> {
  return client.models.providers.$get({ query: {} });
}

// Session expiry

test('a gateway 401 redirects to login and remembers the page', async () => {
  fetchSpy.mockResolvedValue(Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }));

  await expect(listProviders()).rejects.toEqual(new ApiError(401, 'Session expired.'));

  expect(location.href).toBe('/auth/login?redirect_to=%2Fplayground%3Ffrom%3Dlog-1');
});

test('an upstream 401 keeps the provider error and stays on the page', async () => {
  // The provider rejected its own key. The session is fine, so signing in again
  // would fix nothing.
  const upstream = Response.json(
    { error: { message: 'Upstream provider rejected the request: invalid api key' } },
    { status: 401, headers: { 'ai-error-source': 'upstream' } },
  );
  fetchSpy.mockResolvedValue(upstream);

  const request = client.chat.completions.$post({
    header: { 'ai-api-key': 'invalid' },
    json: { model: 'openai/test', messages: [{ role: 'user', content: 'Hello' }] },
  });

  await expect(request).rejects.toThrow('Upstream provider rejected the request: invalid api key');
  expect(location.href).toBe('/playground');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

// Failed requests

test('a failed request surfaces the message the gateway sent', async () => {
  fetchSpy.mockResolvedValue(Response.json({ error: { message: 'Name is required' } }, { status: 422 }));

  await expect(listProviders()).rejects.toEqual(new ApiError(422, 'Name is required'));
});

test('a failed request without a JSON body falls back to its status', async () => {
  fetchSpy.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

  await expect(listProviders()).rejects.toEqual(new ApiError(502, 'Request failed (502).'));
});

// listAllProviders

test('the catalog loader follows provider cursors and combines pages', async () => {
  const { listAllProviders } = await import('../../src/lib/api/models');
  const firstPage = {
    data: [{ id: 'anthropic', synced_at: null, models: [] }],
    meta: { oldest_id: 'anthropic', more_data: true },
  };
  const lastPage = {
    data: [{ id: 'openai', synced_at: null, models: [] }],
    meta: { oldest_id: 'openai', more_data: false },
  };
  fetchSpy.mockResolvedValueOnce(Response.json(firstPage)).mockResolvedValueOnce(Response.json(lastPage));

  const catalog = await listAllProviders();

  expect(catalog.data.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('after_id=anthropic');
});

// fetchSeries

test('a failed name lookup leaves callers unlabelled instead of failing the series', async () => {
  const { fetchSeries } = await import('../../src/lib/api/analytics');
  const caller = { actor_type: 'user', actor_id: '01912d3f-9b4a-7c3d-8e2f-000000000021', requests: 3, cost_total: 1 };
  const series = { interval: 'day', groupings: [{ group_by: ['actor'], points: [caller] }] };
  const request = {
    start_date: '2026-01-01T00:00:00.000Z',
    end_date: '2026-01-02T00:00:00.000Z',
    groupings: [['actor' as const]],
  };

  // Each fetchSeries call asks for the series first, then for the names.
  fetchSpy
    .mockResolvedValueOnce(Response.json(series))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Forbidden' } }, { status: 403 }))
    .mockResolvedValueOnce(Response.json(series))
    .mockResolvedValueOnce(Response.json({ data: [{ ...caller, display: { name: 'Alex' } }] }));

  const [unlabelled] = await fetchSeries(request);
  const [labelled] = await fetchSeries(request);

  expect(unlabelled?.[0]?.requests).toBe(3);
  expect(unlabelled?.[0]?.actor_label).toBeUndefined();
  expect(labelled?.[0]?.actor_label).toBe('Alex');
  expect(fetchSpy).toHaveBeenCalledTimes(4);
});
