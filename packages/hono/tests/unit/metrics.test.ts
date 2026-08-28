import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { exposeMetrics, requestMetrics } from '../../index';

test('requestMetrics records status and normalized route labels for scraping', async () => {
  const app = new Hono();
  app.use('*', requestMetrics());
  app.get('/widgets/:id', (c) => c.text(c.req.param('id')));
  app.get('/metrics', exposeMetrics());

  await app.request('/widgets/one');
  await app.request('/widgets/two');
  const response = await app.request('/metrics');
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('text/plain');
  expect(body).toContain('http_request_duration_seconds');
  expect(body).toContain('method="GET",route="/widgets/:id",status="200",ok="true"');
});

test('metrics exports share one lazily-created registry', () => {
  expect(requestMetrics()).toBe(requestMetrics());
  expect(exposeMetrics()).toBeFunction();
  expect(exposeMetrics()).toBeFunction();
});
