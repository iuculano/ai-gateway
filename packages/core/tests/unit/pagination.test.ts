import { describe, expect, test } from 'bun:test';
import { probe, toPage } from '../../index';

describe('pagination', () => {
  test('probe requests exactly one row beyond the public limit', () => {
    expect(probe(1)).toBe(2);
    expect(probe(50)).toBe(51);
  });

  test('returns empty metadata for an empty result', () => {
    expect(toPage([], 10)).toEqual({
      data: [],
      meta: { oldest_id: null, more_data: false },
    });
  });

  test('does not claim more data for a partial or exactly full page', () => {
    expect(toPage([{ id: 'one' }], 2)).toEqual({
      data: [{ id: 'one' }],
      meta: { oldest_id: 'one', more_data: false },
    });
    expect(toPage([{ id: 'two' }, { id: 'one' }], 2)).toEqual({
      data: [{ id: 'two' }, { id: 'one' }],
      meta: { oldest_id: 'one', more_data: false },
    });
  });

  test('trims the probe row without mutating the query result', () => {
    const rows = [{ id: 'three' }, { id: 'two' }, { id: 'one' }];

    const page = toPage(rows, 2);

    expect(page).toEqual({
      data: [{ id: 'three' }, { id: 'two' }],
      meta: { oldest_id: 'two', more_data: true },
    });
    expect(rows).toHaveLength(3);
  });

  test('supports joined rows through a custom cursor selector', () => {
    const rows = [{ log: { id: 'three' } }, { log: { id: 'two' } }, { log: { id: 'one' } }];

    expect(toPage(rows, 2, (row) => row.log.id)).toEqual({
      data: [{ log: { id: 'three' } }, { log: { id: 'two' } }],
      meta: { oldest_id: 'two', more_data: true },
    });
  });
});
