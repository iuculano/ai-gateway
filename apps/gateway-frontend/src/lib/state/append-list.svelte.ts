import type { ListMeta } from '#lib/api/types.ts';
import type { Page } from '#lib/state/paged-list.svelte.ts';

/**
 * A list that grows, with each further page added to the end of the rows
 * already on show.
 */
export class AppendList<T> {
  rows: T[] = $state([]);
  meta: ListMeta | null = $state(null);
  loading = $state(false);
  error: string | null = $state(null);

  /**
   * Kept apart from `loading`, because adding a page must leave the rows on
   * show alone, and a table swaps itself for a spinner whenever `loading` is
   * set.
   */
  loadingMore = $state(false);

  /**
   * Whether a further page has been added since the last full load. A refresh
   * reads only the first page, so tailing a list that has been paged past its
   * head would throw the later pages away. Auto-refresh reads this to pause
   * itself.
   */
  appended = $state(false);

  readonly #fetchPage: (after?: string) => Promise<Page<T>>;
  readonly #failureMessage: string;

  // Every read takes the next number, and only the one that began last may
  // change the list.
  #request = 0;
  #loaded = false;

  /**
   * @param fetchPage
   * Fetches one page, starting after the given cursor when there is one.
   *
   * @param failureMessage
   * Shown when a rejection carries nothing readable of its own.
   */
  constructor(fetchPage: (after?: string) => Promise<Page<T>>, failureMessage: string) {
    this.#fetchPage = fetchPage;
    this.#failureMessage = failureMessage;
  }

  /**
   * Whether the last page fetched reported more rows behind it.
   */
  get hasMore(): boolean {
    return this.meta?.more_data ?? false;
  }

  /**
   * Reads the first page once. Later calls do nothing.
   */
  async ensureLoaded(): Promise<void> {
    if (!this.#loaded && !this.loading) {
      await this.load();
    }
  }

  /**
   * Reads the first page, dropping anything that was added after it.
   */
  async load(): Promise<void> {
    const request = ++this.#request;

    this.loading = true;
    this.error = null;

    try {
      const page = await this.#fetchPage();

      if (request !== this.#request) {
        return;
      }

      this.rows = page.data;
      this.meta = page.meta;
      this.appended = false;
      this.#loaded = true;
    } catch (error) {
      if (request === this.#request) {
        this.error = error instanceof Error ? error.message : this.#failureMessage;
      }
    } finally {
      if (request === this.#request) {
        this.loading = false;
      }
    }
  }

  /**
   * Adds the next page, when the last one said there is one.
   */
  async loadMore(): Promise<void> {
    const cursor = this.meta?.oldest_id;

    if (this.loading || this.loadingMore || !this.hasMore || !cursor) {
      return;
    }

    const request = ++this.#request;

    this.loadingMore = true;

    try {
      const page = await this.#fetchPage(cursor);

      // A list read again from the top in the meantime has no place for this
      // page.
      if (request !== this.#request) {
        return;
      }

      this.rows = [...this.rows, ...page.data];
      this.meta = page.meta;
      this.appended = true;
    } catch (error) {
      if (request === this.#request) {
        this.error = error instanceof Error ? error.message : this.#failureMessage;
      }
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Reads the first page again without disturbing the table, for a list that
   * is being tailed. It leaves the loading flag and the error alone, because
   * either would swap rows that are still readable for a spinner or a banner,
   * and it throws when the read fails.
   */
  async refresh(): Promise<void> {
    if (this.loading || this.loadingMore) {
      return;
    }

    const request = ++this.#request;
    const page = await this.#fetchPage();

    if (request !== this.#request) {
      return;
    }

    this.rows = page.data;
    this.meta = page.meta;
    this.appended = false;
  }
}
