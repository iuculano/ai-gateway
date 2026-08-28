import { beforeEach, describe, expect, test } from 'bun:test';
import { database, forCaller, installModuleMocks, logRow, resetDoubles, rows } from './doubles';

/**
 * listLogs, which pages in both directions.
 *
 * The existing logs suite asserts only that this function stays a plain promise,
 * so none of the cursor logic below was covered. That logic is the subtle part:
 * paging backwards has to scan ASCENDING to get the adjacent rows and then undo
 * that order in code, and the trim has to happen BEFORE the reversal or the page
 * comes back with a hole in it. The source carries a long comment working
 * through exactly that; these are the cases it describes.
 */

await installModuleMocks();

const Services = forCaller((await import('../../src/api/logs/logs.services')).default);

// Descending ids, so "newest first" is legible in the fixtures.
const ID_20 = '01912d3f-0000-7000-8000-000000000020';
const ID_19 = '01912d3f-0000-7000-8000-000000000019';
const ID_18 = '01912d3f-0000-7000-8000-000000000018';
const ID_17 = '01912d3f-0000-7000-8000-000000000017';

beforeEach(() => {
  resetDoubles();
});

describe('paging forwards', () => {
  test('returns newest first and trims the probe row', async () => {
    // Three rows for a limit of two: the third exists only so more_data can be
    // answered without a second count query.
    database.respondTo('select', 'logs', rows(logRow({ id: ID_20 }), logRow({ id: ID_19 }), logRow({ id: ID_18 })));

    const page = await Services.listLogs({ limit: 2 });

    expect(page.data.map((row) => row.id)).toEqual([ID_20, ID_19]);
    expect(page.meta.more_data).toBe(true);
  });

  test('reports both ends of the page, because this endpoint pages both ways', async () => {
    database.respondTo('select', 'logs', rows(logRow({ id: ID_20 }), logRow({ id: ID_19 })));

    const page = await Services.listLogs({ limit: 2 });

    expect(page.meta.newest_id).toBe(ID_20);
    expect(page.meta.oldest_id).toBe(ID_19);
  });

  test('an empty result carries null cursors rather than undefined', async () => {
    database.respondTo('select', 'logs', rows());

    const page = await Services.listLogs({ limit: 20 });

    expect(page.data).toEqual([]);
    expect(page.meta).toEqual({ newest_id: null, oldest_id: null, more_data: false });
  });
});

describe('paging backwards', () => {
  test('undoes the ascending scan so the page reads newest-first again', async () => {
    // before_id scans ASC to reach the adjacent rows, so the driver hands them
    // back oldest-first. The response must not.
    database.respondTo('select', 'logs', rows(logRow({ id: ID_18 }), logRow({ id: ID_19 }), logRow({ id: ID_20 })));

    const page = await Services.listLogs({ limit: 3, before_id: ID_17 });

    expect(page.data.map((row) => row.id)).toEqual([ID_20, ID_19, ID_18]);
  });

  test('trims the probe before reversing, so the page has no hole in it', async () => {
    // Four ascending rows for a limit of three. The probe is the FOURTH in scan
    // order - the furthest from the cursor - so trimming first keeps 18,19,20
    // contiguous. Reversing first would drop 18 and leave a gap next to the
    // cursor, which is the bug the source comment works through.
    database.respondTo(
      'select',
      'logs',
      rows(
        logRow({ id: ID_18 }),
        logRow({ id: ID_19 }),
        logRow({ id: ID_20 }),
        logRow({ id: '01912d3f-0000-7000-8000-000000000021' }),
      ),
    );

    const page = await Services.listLogs({ limit: 3, before_id: ID_17 });

    expect(page.data.map((row) => row.id)).toEqual([ID_20, ID_19, ID_18]);
    expect(page.meta.more_data).toBe(true);
  });

  test('cursors describe the reversed page, not the scan order', async () => {
    database.respondTo('select', 'logs', rows(logRow({ id: ID_18 }), logRow({ id: ID_19 })));

    const page = await Services.listLogs({ limit: 2, before_id: ID_17 });

    // Recomputed after the reversal - taking them from the pre-reversal page
    // would hand back cursors that page in the wrong direction next time.
    expect(page.meta.newest_id).toBe(ID_19);
    expect(page.meta.oldest_id).toBe(ID_18);
  });
});

describe('filters', () => {
  test('accepts every filter at once without disturbing the shape', async () => {
    database.respondTo('select', 'logs', rows(logRow({ id: ID_20 })));

    const page = await Services.listLogs({
      limit: 20,
      model: 'gpt-5',
      provider: 'openai',
      status: 'complete',
      tags: 'env:prod,team:core',
      after_id: ID_20,
    });

    expect(page.data).toHaveLength(1);
    expect(page.meta.more_data).toBe(false);
  });

  test('rows come back in the derived shape, not raw', async () => {
    // has_request / has_response are derived from the key columns, and the key
    // columns themselves must not reach the caller.
    database.respondTo(
      'select',
      'logs',
      rows(logRow({ id: ID_20, request_object_reference: 'logs/x/request.json.zst', response_object_reference: null })),
    );

    const page = await Services.listLogs({ limit: 20 });
    const row = page.data[0] as Record<string, unknown>;

    expect(row.has_request).toBe(true);
    expect(row.has_response).toBe(false);
    expect(row.request_object_reference).toBeUndefined();
    expect(row.response_object_reference).toBeUndefined();
  });
});
