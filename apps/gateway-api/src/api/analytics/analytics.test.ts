import { test, expect } from 'bun:test';
import { app } from '../../index';

// Test successful request
test('returns 200 for valid analytics request', async () => {
  const res = await app.request('/v1/analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: { foo: 'bar' } }),
  });

  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toHaveProperty('total_logs');
  expect(json.total_logs).toBe(1);
});

// Test error case
test('returns 418 for missing tags', async () => {
  const res = await app.request('/v1/analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(418);
  const json = await res.json();
  expect(json).toHaveProperty('error');
  expect(json.error.status).toBe("I'M_A_TEAPOT");
});
