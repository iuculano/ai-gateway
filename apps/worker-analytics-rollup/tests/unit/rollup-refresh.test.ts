import { beforeEach, expect, mock, test } from 'bun:test';
import { createDatabaseDouble, rows } from '@repo/test-helpers';

process.env.POSTGRES_CONNECTION_STRING = 'postgresql://test:test@localhost/worker_unit_test';
process.env.ROLLUP_CHUNK_HOURS = '2';

const { database, db } = createDatabaseDouble();
const actualDrizzle = await import('@repo/drizzle');

mock.module('@repo/drizzle', () => ({ ...actualDrizzle, db }));

const { tickAnalyticsRollup } = await import('../../src/worker/rollup-refresh');

const FROM = new Date('2026-08-21T00:00:00.000Z');
const TO = new Date('2026-08-21T05:00:00.000Z');

beforeEach(() => {
  database.reset();
});

test('stays idle when there is no logged history to refresh', async () => {
  database.script(rows({ hour: TO }), rows({ start: null }));

  expect(await tickAnalyticsRollup()).toEqual({ status: 'idle', chunks: 0, rows: 0 });
  expect(database.transactions).toHaveLength(0);
});

test('stays idle when the watermark has reached the current hour', async () => {
  database.script(rows({ hour: TO }), rows({ start: TO }));

  expect(await tickAnalyticsRollup()).toEqual({ status: 'idle', chunks: 0, rows: 0 });
});

test('refreshes an old range in configured chunks and totals the rows written', async () => {
  database.script(
    rows({ hour: TO }),
    rows({ start: FROM }),
    rows({ acquired: true }),
    rows(),
    rows({ rows: 1 }),
    rows({ acquired: true }),
    rows(),
    rows({ rows: 2 }),
    rows({ acquired: true }),
    rows(),
    rows({ rows: 3 }),
  );

  expect(await tickAnalyticsRollup()).toEqual({
    status: 'written',
    chunks: 3,
    rows: 6,
    from: FROM,
    to: TO,
  });
  expect(database.transactions).toEqual([
    { committed: true, rolledBack: false },
    { committed: true, rolledBack: false },
    { committed: true, rolledBack: false },
  ]);
});

test('stops at a locked chunk so the next tick can resume from the real watermark', async () => {
  database.script(
    rows({ hour: TO }),
    rows({ start: FROM }),
    rows({ acquired: true }),
    rows(),
    rows({ rows: 4 }),
    rows({ acquired: false }),
  );

  expect(await tickAnalyticsRollup()).toEqual({
    status: 'locked',
    chunks: 1,
    rows: 4,
    from: FROM,
    to: TO,
  });
});

test('rolls a failed replacement transaction back to its previous contents', async () => {
  const failure = new Error('insert failed');
  database.script(rows({ hour: TO }), rows({ start: FROM }), rows({ acquired: true }), rows(), { error: failure });

  await expect(tickAnalyticsRollup()).rejects.toThrow('insert failed');
  expect(database.transactions).toEqual([{ committed: false, rolledBack: true }]);
});
