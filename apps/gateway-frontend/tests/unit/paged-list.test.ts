import { beforeEach, expect, mock, test } from 'bun:test';
import type { ListMeta } from '../../src/lib/api/types';
import { PagedList } from '../../src/lib/state/paged-list.svelte';

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
async function loadedList(): Promise<PagedList<Row>> {
  const list = new PagedList<Row>(fetchPage, 'Failed to load.');
  await list.ensureLoaded();

  return list;
}

test('a list is pending until its first page comes back, or fails to', async () => {
  const fresh = new PagedList<Row>(fetchPage, 'Failed to load.');
  const failing = new PagedList<Row>(() => Promise.reject(new Error('Offline')), 'Failed to load.');
  const before = fresh.pending;

  await fresh.ensureLoaded();
  await failing.ensureLoaded();

  // A list whose first page failed has an error to show, and is not waiting.
  expect([before, fresh.pending, failing.pending]).toEqual([true, false, false]);
});

test('the next page is asked for after the last row shown, and replaces the rows', async () => {
  const list = await loadedList();
  fetchPage.mockResolvedValueOnce(page('second', true));

  await list.nextPage();

  expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([undefined, 'first']);
  expect(list.rows.map((row) => row.id)).toEqual(['second']);
  expect(list.pageIndex).toBe(1);
});

test('going back asks for the previous page again, from its own cursor', async () => {
  const list = await loadedList();
  fetchPage.mockResolvedValueOnce(page('second', true));
  fetchPage.mockResolvedValueOnce(page('third', false));
  await list.nextPage();
  await list.nextPage();

  await list.previousPage();

  expect(list.pageIndex).toBe(1);
  expect(fetchPage.mock.calls.at(-1)?.[0]).toBe('first');
});

test('starting again goes back to the first page and forgets the cursors', async () => {
  const list = await loadedList();
  await list.nextPage();
  fetchPage.mockResolvedValueOnce(page('filtered', false));

  await list.restart();

  expect(fetchPage.mock.calls.at(-1)?.[0]).toBeUndefined();
  expect(list.rows[0]?.id).toBe('filtered');
  expect(list.pageIndex).toBe(0);
  expect(list.hasMore).toBe(false);
});

test('a page that arrives after the list was started again is discarded', async () => {
  const list = await loadedList();
  const stale = Promise.withResolvers<RowPage>();
  fetchPage.mockReturnValueOnce(stale.promise);
  fetchPage.mockResolvedValueOnce(page('filtered', false));

  const staleRequest = list.nextPage();
  await list.restart();
  stale.resolve(page('stale', true));
  await staleRequest;

  expect(list.rows[0]?.id).toBe('filtered');
  expect(list.pageIndex).toBe(0);
});

test('a failed page keeps the current one and can be retried', async () => {
  const list = await loadedList();
  fetchPage.mockRejectedValueOnce(new Error('Offline'));

  await list.nextPage();

  expect(list.error).toBe('Offline');
  expect(list.pageIndex).toBe(0);
  expect(list.rows[0]?.id).toBe('first');

  fetchPage.mockResolvedValueOnce(page('second', false));

  await list.nextPage();

  expect(list.error).toBeNull();
  expect(list.pageIndex).toBe(1);
});

test('the last page asks for nothing further', async () => {
  const list = await loadedList();
  fetchPage.mockResolvedValueOnce(page('second', false));
  await list.nextPage();
  const requests = fetchPage.mock.calls.length;

  await list.nextPage();

  expect(fetchPage.mock.calls.length).toBe(requests);
});

test('a refresh only happens on the first page', async () => {
  const list = await loadedList();
  await list.nextPage();
  const requests = fetchPage.mock.calls.length;

  // Refreshing a later page would shift its rows under the reader.
  await list.refresh();

  expect(fetchPage.mock.calls.length).toBe(requests);

  await list.previousPage();
  await list.refresh();

  expect(fetchPage.mock.calls.length).toBe(requests + 2);
});

test('a refresh that fails leaves the table as it was, and says so by throwing', async () => {
  const list = await loadedList();
  fetchPage.mockRejectedValueOnce(new Error('Offline'));

  const refresh = list.refresh();
  const loadingDuring = list.loading;

  await expect(refresh).rejects.toThrow('Offline');

  expect(loadingDuring).toBe(false);
  expect(list.error).toBeNull();
  expect(list.rows[0]?.id).toBe('first');
});
