import { beforeEach, expect, test } from 'bun:test';
import { database, forCaller, installModuleMocks, resetDoubles, rows } from './doubles';

await installModuleMocks();
const Services = forCaller((await import('../../src/api/logs/logs.services')).default);
beforeEach(resetDoubles);

test('counts each status exactly and returns only counts', async () => {
  database.respondTo('execute', null, ...[10, 2, 1].map((count) => rows({ count })));
  expect(await Services.countLogs()).toEqual({
    total: 13,
    estimated: false,
    by_status: { complete: 10, failed: 2, incomplete: 1 },
  });
});

test('empty organizations return exact zeroes', async () => {
  database.respondTo('execute', null, ...[0, 0, 0].map((count) => rows({ count })));
  expect(await Services.countLogs()).toEqual({
    total: 0,
    estimated: false,
    by_status: { complete: 0, failed: 0, incomplete: 0 },
  });
});

test('combines estimated large statuses with exact small statuses', async () => {
  database.respondTo(
    'execute',
    null,
    rows({ count: 100001 }),
    rows({ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 2800000 } }] }),
    rows({ count: 100001 }),
    rows({ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 170000 } }] }),
    rows({ count: 30000 }),
  );
  expect(await Services.countLogs()).toEqual({
    total: 3000000,
    estimated: true,
    by_status: { complete: 2800000, failed: 170000, incomplete: 30000 },
  });
});
