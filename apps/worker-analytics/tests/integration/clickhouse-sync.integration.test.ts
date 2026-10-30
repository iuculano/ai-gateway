import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { admin, prepareSuite, resetDatabase } from './setup';

const { clickhouse } = await import('@repo/clickhouse');
const { tickAnalyticsSync } = await import('../../src/worker/clickhouse-sync');

let organizationId: string;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  const [organization] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values ('sync-test', 'test-idp', 'Sync Test', 'sync-test')
    returning id
  `;
  organizationId = organization.id;
});

afterAll(async () => {
  await resetDatabase();
  await admin.close();
});

async function seedLog(entry: {
  updatedAt: string;
  inputTokens?: number | null;
  latency?: number | null;
  tags?: Record<string, string>;
}) {
  // A timestamp, or 'now' for a row written this moment.
  const updatedAt = entry.updatedAt === 'now' ? new Date().toISOString() : entry.updatedAt;
  const [row] = await admin`
    insert into logs (organization_id, operation, model, provider, status, actor_id,
                      input_tokens, output_tokens, input_cost, output_cost, response_time_ms, created_at, updated_at, tags)
    values (${organizationId}, 'chat', 'gpt-5-mini', 'openai', 'complete', gen_random_uuid(),
            ${entry.inputTokens === undefined ? 10 : entry.inputTokens}, 5, 0.000025, 0.00001,
            ${entry.latency === undefined ? 100 : entry.latency}, now() - interval '1 minute', ${updatedAt}::timestamptz,
            ${entry.tags ?? null}::jsonb)
    returning id
  `;
  return row.id as string;
}

async function rowsOf<T>(query: string): Promise<T[]> {
  return (await clickhouse.query({ query: query, format: 'JSONEachRow' })).json<T>();
}

async function synced() {
  const [row] = await rowsOf<{ rows: number; input_tokens: number; latency: number | null }>(
    'SELECT count() AS rows, sum(input_tokens) AS input_tokens, avg(response_time_ms) AS latency FROM logs FINAL',
  );
  if (!row) {
    throw new Error('ClickHouse returned no aggregate row');
  }
  return row;
}

test('a first sync copies every row, across batches and through rows sharing a timestamp', async () => {
  const same = '2026-10-28 01:00:00.123456+00';
  for (let i = 0; i < 3; i++) {
    await seedLog({ updatedAt: same });
  }
  await seedLog({ updatedAt: '2026-10-28 01:00:05+00', inputTokens: null, latency: null });

  const result = await tickAnalyticsSync();

  expect(result.rows).toBe(4);
  expect(result.batches).toBe(2);
  // The null tokens count as zero; the null latency stays out of the average.
  expect(await synced()).toEqual({ rows: 4, input_tokens: 30, latency: 100 });
});

test('running again copies nothing it already has', async () => {
  await seedLog({ updatedAt: '2026-10-28 01:00:00+00' });
  await seedLog({ updatedAt: '2026-10-28 01:00:30+00' });
  await tickAnalyticsSync();

  const again = await tickAnalyticsSync();

  expect(again.rows).toBe(0);
  expect((await synced()).rows).toBe(2);
});

test('rows from the last half minute wait until they have settled', async () => {
  await seedLog({ updatedAt: '2026-10-28 01:00:00+00' });
  const fresh = await seedLog({ updatedAt: 'now' });

  const result = await tickAnalyticsSync();

  expect(result.rows).toBe(1);
  const ids = await rowsOf<{ id: string }>('SELECT id FROM logs FINAL');
  expect(ids.map((row) => row.id)).not.toContain(fresh);
});

test('microseconds survive the cursor: no row is skipped or repeated at a sub-millisecond boundary', async () => {
  await seedLog({ updatedAt: '2026-10-28 01:00:00.000100+00' });
  await seedLog({ updatedAt: '2026-10-28 01:00:00.000200+00' });
  await seedLog({ updatedAt: '2026-10-28 01:00:00.000300+00' });

  const result = await tickAnalyticsSync();

  expect(result.rows).toBe(3);
  const [range] = await rowsOf<{ low: string; high: string }>(
    'SELECT toString(min(updated_at)) AS low, toString(max(updated_at)) AS high FROM logs',
  );
  expect(range).toEqual({ low: '2026-10-28 01:00:00.000100', high: '2026-10-28 01:00:00.000300' });
});

test('tags are copied, and the well-known ones land in their own columns', async () => {
  await seedLog({ updatedAt: '2026-10-28 01:00:00+00', tags: { user_id: 'u-1', session_id: 's-1', team: 'search' } });
  await seedLog({ updatedAt: '2026-10-28 01:00:01+00' });

  await tickAnalyticsSync();

  const rows = await rowsOf<{ tags: Record<string, string>; user_id: string; session_id: string }>(
    'SELECT tags, user_id, session_id FROM logs FINAL ORDER BY updated_at',
  );
  expect(rows).toEqual([
    { tags: { user_id: 'u-1', session_id: 's-1', team: 'search' }, user_id: 'u-1', session_id: 's-1' },
    { tags: {}, user_id: '', session_id: '' },
  ]);
});

test('a batch that only partly landed is copied again, not skipped', async () => {
  const older = await seedLog({ updatedAt: '2026-10-28 01:00:00+00' });
  await seedLog({ updatedAt: '2026-10-28 01:00:01+00' });
  await tickAnalyticsSync();

  // As if the batch's newer part landed and its older one didn't, so the cursor
  // never moved: the newest row in logs is no longer where the sync is up to.
  await clickhouse.command({ query: `ALTER TABLE logs DELETE WHERE id = '${older}' SETTINGS mutations_sync = 2` });
  await clickhouse.command({ query: 'TRUNCATE TABLE sync_cursor SYNC' });

  await tickAnalyticsSync();

  expect((await synced()).rows).toBe(2);
});
