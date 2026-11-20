import { beforeEach, expect, mock, test } from 'bun:test';
import { plugin, Transpiler } from 'bun';
import { compileModule } from 'svelte/compiler';
import type { ListPromptsQuery } from '../../src/lib/api/prompts';
import type { ListMeta, Prompt } from '../../src/lib/api/types';

// Compile the actual rune-based store so these tests exercise request races
// and cursor state, without replacing its reactivity with a test double.
plugin({
  name: 'prompt-list-runes',
  setup(build): void {
    build.onLoad({ filter: /prompt-list\.svelte\.ts$/ }, async ({ path }) => {
      const source = new Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text());
      const compiled = compileModule(source, { filename: path, generate: 'client' });

      return { contents: compiled.js.code, loader: 'js' };
    });
  },
});

type Page = { data: Prompt[]; meta: ListMeta };

/**
 * A page holding one prompt, whose id is also the cursor to the next page.
 */
function page(id: string, more: boolean): Page {
  return { data: [{ id } as Prompt], meta: { oldest_id: id, more_data: more } };
}

const listPrompts = mock((_query: ListPromptsQuery): Promise<Page> => Promise.resolve(page('first', true)));

// Must precede the import below, which is what loads the store.
mock.module(new URL('../../src/lib/api/prompts.ts', import.meta.url).pathname, () => ({ listPrompts }));

const { PromptList } = await import('../../src/lib/state/prompt-list.svelte');

beforeEach(() => {
  listPrompts.mockReset();
  listPrompts.mockImplementation(() => Promise.resolve(page('first', true)));
});

/**
 * A list that has loaded its first page, which has more behind it.
 */
async function loadedList(): Promise<InstanceType<typeof PromptList>> {
  const list = new PromptList();
  await list.ensureLoaded();

  return list;
}

test('loads 20 at a time and replaces the rows with each page', async () => {
  const list = await loadedList();
  listPrompts.mockResolvedValueOnce(page('second', true));

  await list.nextPage();

  expect(listPrompts.mock.calls[0]?.[0]).toEqual({ limit: 20, status: 'all', after_id: undefined });
  expect(listPrompts.mock.calls[1]?.[0].after_id).toBe('first');
  expect(list.rows.map((row) => row.id)).toEqual(['second']);
  expect(list.pageIndex).toBe(1);
});

test('going back asks for the previous page again, from its own cursor', async () => {
  const list = await loadedList();
  await list.nextPage();

  await list.previousPage();

  expect(list.pageIndex).toBe(0);
  expect(listPrompts.mock.calls.at(-1)?.[0].after_id).toBeUndefined();
});

test('a filter change resets to the first page of the new filter', async () => {
  const list = await loadedList();
  await list.nextPage();
  listPrompts.mockResolvedValueOnce(page('versioned', false));

  await list.filterByStatus('versioned');

  expect(listPrompts.mock.calls.at(-1)?.[0]).toEqual({ limit: 20, status: 'versioned', after_id: undefined });
  expect(list.rows[0]?.id).toBe('versioned');
  expect(list.pageIndex).toBe(0);
  expect(list.hasMore).toBe(false);
});

test('a page that arrives after the filter changed is discarded', async () => {
  const list = await loadedList();
  let finishStale!: (page: Page) => void;
  const stale = new Promise<Page>((resolve) => {
    finishStale = resolve;
  });
  listPrompts.mockReturnValueOnce(stale);
  listPrompts.mockResolvedValueOnce(page('versioned', false));

  const staleRequest = list.nextPage();
  await list.filterByStatus('versioned');
  finishStale(page('stale', true));
  await staleRequest;

  expect(list.rows[0]?.id).toBe('versioned');
  expect(list.pageIndex).toBe(0);
});

test('a failed page keeps the current one and can be retried', async () => {
  const list = await loadedList();
  listPrompts.mockRejectedValueOnce(new Error('Offline'));

  await list.nextPage();

  expect(list.error).toBe('Offline');
  expect(list.pageIndex).toBe(0);
  expect(list.rows[0]?.id).toBe('first');

  listPrompts.mockResolvedValueOnce(page('second', false));

  await list.nextPage();

  expect(list.error).toBeNull();
  expect(list.pageIndex).toBe(1);
});

test('the last page asks for nothing further', async () => {
  const list = await loadedList();
  listPrompts.mockResolvedValueOnce(page('second', false));
  await list.nextPage();
  const requests = listPrompts.mock.calls.length;

  await list.nextPage();

  expect(listPrompts.mock.calls.length).toBe(requests);
});

test('a background refresh only happens on the first page', async () => {
  const list = await loadedList();
  await list.nextPage();
  const requests = listPrompts.mock.calls.length;

  // Refreshing a later page would shift its rows under the reader.
  await list.refresh();

  expect(listPrompts.mock.calls.length).toBe(requests);

  await list.previousPage();
  await list.refresh();

  expect(listPrompts.mock.calls.length).toBe(requests + 2);
});
