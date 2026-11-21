import { beforeEach, expect, mock, test } from 'bun:test';
import type { ListMeta } from '../../src/lib/api/types';
import { AppendList } from '../../src/lib/state/append-list.svelte';

interface Row {
  id: string;
}

type RowPage = { data: Row[]; meta: ListMeta };

/**
 * A page holding one row, whose id is also the cursor to the next page.
 */
function page(id: string, more: boolean): RowPage {
  return { data: [{ id: id }], meta: { oldest_id: id, more_data: more } };
}

const fetchPage = mock((_after?: string): Promise<RowPage> => Promise.resolve(page('first', true)));

beforeEach(() => {
  fetchPage.mockReset();
  fetchPage.mockImplementation(() => Promise.resolve(page('first', true)));
});

/**
 * A list that has loaded its first page, which has more behind it.
 */
async function loadedList(): Promise<AppendList<Row>> {
  const list = new AppendList<Row>(fetchPage, 'Failed to load.');
  await list.ensureLoaded();

  return list;
}

test('more rows are asked for after the last one shown, and added to the end', async () => {
  const list = await loadedList();
  fetchPage.mockResolvedValueOnce(page('second', false));

  await list.loadMore();

  expect(fetchPage.mock.calls.at(-1)?.[0]).toBe('first');
  expect(list.rows.map((row) => row.id)).toEqual(['first', 'second']);
  expect(list.appended).toBe(true);
});

test('the last page asks for nothing more', async () => {
  const list = await loadedList();
  fetchPage.mockResolvedValueOnce(page('second', false));
  await list.loadMore();
  const requests = fetchPage.mock.calls.length;

  await list.loadMore();

  expect(fetchPage.mock.calls.length).toBe(requests);
});

test('loading again from the top drops what was added', async () => {
  const list = await loadedList();
  await list.loadMore();

  await list.load();

  expect(list.rows.map((row) => row.id)).toEqual(['first']);
  expect(list.appended).toBe(false);
});

test('a read that began later wins over one that is still out', async () => {
  const list = new AppendList<Row>(fetchPage, 'Failed to load.');
  const older = Promise.withResolvers<RowPage>();
  const newer = Promise.withResolvers<RowPage>();
  fetchPage.mockReturnValueOnce(older.promise);
  fetchPage.mockReturnValueOnce(newer.promise);

  const first = list.load();
  const second = list.load();
  older.resolve(page('older', true));
  await first;
  const between = [list.rows.length, list.loading];
  newer.resolve(page('newer', false));
  await second;

  // The older read neither shows its rows nor ends the wait for the newer one.
  expect(between).toEqual([0, true]);
  expect(list.rows.map((row) => row.id)).toEqual(['newer']);
  expect(list.loading).toBe(false);
});

test('a page that arrives after the list was read again is dropped', async () => {
  const list = await loadedList();
  const slow = Promise.withResolvers<RowPage>();
  fetchPage.mockReturnValueOnce(slow.promise);
  fetchPage.mockResolvedValueOnce(page('other', true));

  const append = list.loadMore();
  await list.load();
  slow.resolve(page('second', false));
  await append;

  expect(list.rows.map((row) => row.id)).toEqual(['other']);
  expect(list.appended).toBe(false);
  expect(list.loadingMore).toBe(false);
});

test('a refresh overtaken by a full read changes nothing', async () => {
  const list = await loadedList();
  const slow = Promise.withResolvers<RowPage>();
  fetchPage.mockReturnValueOnce(slow.promise);
  fetchPage.mockResolvedValueOnce(page('reloaded', true));

  const refresh = list.refresh();
  await list.load();
  slow.resolve(page('stale', true));
  await refresh;

  expect(list.rows.map((row) => row.id)).toEqual(['reloaded']);
});

test('a failed append keeps the rows and reports what went wrong', async () => {
  const list = await loadedList();
  fetchPage.mockRejectedValueOnce('not an error object');

  await list.loadMore();

  expect(list.rows.map((row) => row.id)).toEqual(['first']);
  expect(list.error).toBe('Failed to load.');
  expect(list.loadingMore).toBe(false);
});

test('a refresh reads the head again without a spinner', async () => {
  const list = await loadedList();
  await list.loadMore();
  fetchPage.mockResolvedValueOnce(page('newest', true));

  const refresh = list.refresh();
  const loadingDuring = list.loading;
  await refresh;

  expect(loadingDuring).toBe(false);
  expect(list.rows.map((row) => row.id)).toEqual(['newest']);
  expect(list.appended).toBe(false);
});

test('a refresh that fails leaves the table as it was, and says so by throwing', async () => {
  const list = await loadedList();
  fetchPage.mockRejectedValueOnce(new Error('Offline'));

  await expect(list.refresh()).rejects.toThrow('Offline');

  expect(list.error).toBeNull();
  expect(list.rows[0]?.id).toBe('first');
});
