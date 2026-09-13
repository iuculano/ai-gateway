import { beforeEach, expect, mock, test } from 'bun:test';
import { plugin, Transpiler } from 'bun';
import { compileModule } from 'svelte/compiler';
import type { ListPromptsQuery } from '../../src/lib/api/prompts';
import type { ListMeta, Prompt } from '../../src/lib/api/types';

// Compile the actual rune-based store so these tests exercise request races
// and cursor state, without replacing its reactivity with a test double.
plugin({
  name: 'prompt-list-runes',
  setup(build) {
    build.onLoad({ filter: /prompt-list\.svelte\.ts$/ }, async ({ path }) => {
      const source = new Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(source, { filename: path, generate: 'client' }).js.code, loader: 'js' };
    });
  },
});

type Page = { data: Prompt[]; meta: ListMeta };
const listPrompts = mock((_query: ListPromptsQuery): Promise<Page> => Promise.resolve(page('first', true)));
mock.module(new URL('../../src/lib/api/prompts.ts', import.meta.url).pathname, () => ({ listPrompts }));
const { PromptList } = await import('../../src/lib/state/prompt-list.svelte');

function page(id: string, more: boolean): Page {
  return { data: [{ id } as Prompt], meta: { oldest_id: id, more_data: more } };
}

beforeEach(() => {
  listPrompts.mockReset();
  listPrompts.mockImplementation(() => Promise.resolve(page('first', true)));
});

test('loads 20 at a time, replaces rows, and returns to the previous cursor', async () => {
  const list = new PromptList();
  await list.ensureLoaded();
  expect(listPrompts.mock.calls[0]?.[0]).toEqual({ limit: 20, status: 'all', after_id: undefined });
  listPrompts.mockResolvedValueOnce(page('second', true));
  await list.nextPage();
  expect(list.rows.map((row) => row.id)).toEqual(['second']);
  expect(list.pageIndex).toBe(1);
  expect(listPrompts.mock.calls[1]?.[0].after_id).toBe('first');
  await list.previousPage();
  expect(list.pageIndex).toBe(0);
  expect(listPrompts.mock.calls[2]?.[0].after_id).toBeUndefined();
});

test('filter changes reset pagination and discard stale page responses', async () => {
  const list = new PromptList();
  await list.ensureLoaded();
  let finishOld!: (page: Page) => void;
  listPrompts.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const oldRequest = list.nextPage();
  listPrompts.mockResolvedValueOnce(page('versioned', false));
  await list.filterByStatus('versioned');
  finishOld(page('stale', true));
  await oldRequest;
  expect(list.rows[0]?.id).toBe('versioned');
  expect(list.pageIndex).toBe(0);
  expect(list.hasMore).toBe(false);
  expect(listPrompts.mock.calls.at(-1)?.[0]).toEqual({ limit: 20, status: 'versioned', after_id: undefined });
  await list.filterByStatus('unversioned');
  expect(listPrompts.mock.calls.at(-1)?.[0].status).toBe('unversioned');
});

test('failed navigation preserves the current page and can be retried', async () => {
  const list = new PromptList();
  await list.ensureLoaded();
  listPrompts.mockRejectedValueOnce(new Error('Offline'));
  await list.nextPage();
  expect(list.pageIndex).toBe(0);
  expect(list.rows[0]?.id).toBe('first');
  expect(list.error).toBe('Offline');
  listPrompts.mockResolvedValueOnce(page('second', false));
  await list.nextPage();
  expect(list.pageIndex).toBe(1);
  expect(list.error).toBeNull();
  const count = listPrompts.mock.calls.length;
  await list.refresh();
  await list.nextPage();
  expect(listPrompts.mock.calls.length).toBe(count);
});
