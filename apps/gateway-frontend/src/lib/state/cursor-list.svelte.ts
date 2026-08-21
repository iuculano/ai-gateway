import type { ListMeta } from '$lib/api/types';

export interface CursorPage<T> {
  data: T[];
  meta: ListMeta;
}

/**
 * One cursor-paginated table's worth of state.
 *
 * The webhooks page drives three lists at once - endpoints, outbox and
 * deliveries - which are the same object three times over: fetch a page, append
 * the next one behind a cursor, keep a loading flag and an error string. Written
 * out by hand that is the audit page's loader tripled, and the three copies
 * would be free to drift the way the tables themselves once did.
 *
 * `loadingMore` is deliberately separate from `loading`: appending must leave
 * the rows already on screen alone, and TableCard swaps the whole table for a
 * spinner whenever `loading` is set.
 */
export class CursorList<T> {
  rows: T[] = $state([]);
  meta: ListMeta | null = $state(null);
  loading = $state(false);
  loadingMore = $state(false);
  error: string | null = $state(null);

  /**
   * Whether loadMore() has appended anything since the last full load.
   *
   * refresh() re-reads only the FIRST page, so tailing a list that has been
   * paged past the head would silently throw those pages away. Auto-refresh
   * reads this to pause itself instead - the same gate the logs page applies
   * with its page index.
   */
  appended = $state(false);

  readonly #fetchPage: (after?: string) => Promise<CursorPage<T>>;
  readonly #failureMessage: string;
  #loaded = false;

  /**
   * @param fetchPage
   * Fetches one page, starting after the given cursor id when there is one.
   *
   * @param failureMessage
   * Shown when a rejection carries nothing readable of its own.
   */
  constructor(fetchPage: (after?: string) => Promise<CursorPage<T>>, failureMessage: string) {
    this.#fetchPage = fetchPage;
    this.#failureMessage = failureMessage;
  }

  /** Whether the last page fetched reported more rows behind it. */
  get hasMore(): boolean {
    return this.meta?.more_data ?? false;
  }

  /** Fetches the first page once; later calls are no-ops. Use load() to force. */
  async ensureLoaded(): Promise<void> {
    if (!this.#loaded && !this.loading) {
      await this.load();
    }
  }

  /** (Re)reads the first page, discarding anything already appended to it. */
  async load(): Promise<void> {
    if (this.loading) return; // Don't stack overlapping fetches.
    this.loading = true;
    this.error = null;

    try {
      const page = await this.#fetchPage();
      this.rows = page.data;
      this.meta = page.meta;
      this.appended = false;
      this.#loaded = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.#failureMessage;
    } finally {
      this.loading = false;
    }
  }

  /** Appends the next page, if the last one said there is one. */
  async loadMore(): Promise<void> {
    const cursor = this.meta?.oldest_id;
    if (this.loading || this.loadingMore || !this.hasMore || !cursor) return;

    this.loadingMore = true;

    try {
      const page = await this.#fetchPage(cursor);
      this.rows = [...this.rows, ...page.data];
      this.meta = page.meta;
      this.appended = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : this.#failureMessage;
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Re-reads the first page without disturbing the table.
   *
   * Deliberately touches neither `loading` nor `error`: the first would swap
   * the rows for a spinner every tick, and the second would raise a banner over
   * a table that is still perfectly readable. It throws instead, and AutoRefresh
   * turns itself off on the way past.
   */
  async refresh(): Promise<void> {
    if (this.loading || this.loadingMore) return;

    const page = await this.#fetchPage();

    this.rows = page.data;
    this.meta = page.meta;
    this.appended = false;
  }
}
