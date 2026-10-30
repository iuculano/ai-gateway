import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createClient } from '@clickhouse/client';

const url = process.env.CLICKHOUSE_TEST_URL;
if (!url) {
  throw new Error('Set CLICKHOUSE_TEST_URL, e.g. http://host.docker.internal:8123');
}

// The shared client reads its settings when first imported, so point it at a
// throwaway database before importing it.
const database = `client_test_${crypto.randomUUID().replaceAll('-', '')}`;
process.env.CLICKHOUSE_URL = url;
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_TEST_PASSWORD ?? '';
process.env.CLICKHOUSE_DATABASE = database;

const { ClickHouseError, clickhouse, ensureSchema } = await import('../../index');

// Creates and drops that database, from the default one.
const admin = createClient({ url, password: process.env.CLICKHOUSE_TEST_PASSWORD });

beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE ${database}` });
  await ensureSchema(clickhouse);
});
afterAll(() => admin.command({ query: `DROP DATABASE ${database} SYNC` }));

const org = '019fe984-9759-72dd-a004-e2079d5e2c3f';
function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: org,
    created_at: '2026-10-28 01:00:00.000',
    updated_at: '2026-10-28 01:00:01.000000',
    operation: 'chat',
    model: 'gpt-5-mini',
    provider: 'openai',
    status: 'complete',
    actor_id: '019fe984-9759-72dd-a004-e2079d5e2c40',
    input_tokens: 10,
    output_tokens: 5,
    input_cost: 0.000025,
    output_cost: 0.00001,
    response_time_ms: 120,
    ...overrides,
  };
}

test('rows inserted twice read back once, with typed parameters binding the filter', async () => {
  const id = '01a18014-3023-729b-b27b-aacc1742b483';
  const values = [row(id), row('01a18014-3023-729b-b27b-aacc1742b484', { response_time_ms: null })];
  await clickhouse.insert({ table: 'logs', values: values, format: 'JSONEachRow' });
  await clickhouse.insert({
    table: 'logs',
    values: [row(id, { updated_at: '2026-10-28 01:00:02.000000' })],
    format: 'JSONEachRow',
  });

  const result = await clickhouse.query({
    query: `SELECT count() AS requests, sum(input_tokens) AS input_tokens, avg(response_time_ms) AS latency
            FROM logs FINAL WHERE organization_id = {organization:UUID} AND created_at >= {from:DateTime64(3)}`,
    query_params: { organization: org, from: new Date('2026-10-28T00:00:00Z') },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ requests: number; input_tokens: number; latency: number }>();

  expect(rows).toEqual([{ requests: 2, input_tokens: 20, latency: 120 }]);
});

test('a malformed query is a ClickHouseError', async () => {
  await expect(clickhouse.query({ query: 'SELECT nope FROM logs' })).rejects.toThrow(ClickHouseError);
});

test('tables keep their data in object storage, zstd-compressed', async () => {
  const result = await clickhouse.query({
    query: `SELECT disk_name, default_compression_codec FROM system.parts
            WHERE database = {database:String} AND table = 'logs' AND active LIMIT 1`,
    query_params: { database },
    format: 'JSONEachRow',
  });
  const [part] = await result.json<{ disk_name: string; default_compression_codec: string }>();
  expect(part).toEqual({ disk_name: 'object_store_cache', default_compression_codec: 'ZSTD(3)' });
});
