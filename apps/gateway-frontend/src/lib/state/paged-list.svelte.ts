import type { ListMeta } from '#lib/api/types.ts';

interface PageMeta {
  oldest_id: string | null;
  more_data: boolean;
}

export interface Page<T, M extends PageMeta = ListMeta> {
  data: T[];
  meta: M;
}

/**
 * A list read one page at a time, with a step forward and a step back.
 *
 * The filter a list is under belongs to whoever owns it. The fetch reads it,
 * and a change to it is followed by `restart`.
 */
export class PagedList<T, M extends PageMeta = ListMeta> {
  rows: T[] = $state([]);
  meta: M | null = $state(null);
  loading = $state(false);
  error: string | null = $state(null);

  /**
   * Zero-based. Page 0 is the head of the list, and the only page a refresh
   * reads again.
   */
  pageIndex = $state(0);

  readonly #fetchPage: (after?: string) => Promise<Page<T, M>>;
  readonly #failureMessage: string;

  // The cursor that opens each page past the first, so that the cursor at i
  // opens page i + 1. A cursor only walks one step, and keeping the ones
  // already used is what lets a step back happen without walking down from the
  // top again.
  //
  // Every fetch is therefore a forward scan, including the ones that step back.
  // `more_data` says whether the scan direction has more rows, so reading
  // backwards would leave it answering whether there are newer rows at the
  // moment the next button needs to know about older ones.
  #cursors: string[] = [];
  #request = 0;
  #loaded = $state(false);

  /**
   * @param fetchPage
   * Fetches one page, starting after the given cursor when there is one.
   *
   * @param failureMessage
   * Shown when a rejection carries nothing readable of its own.
   */
  constructor(fetchPage: (after?: string) => Promise<Page<T, M>>, failureMessage: string) {
    this.#fetchPage = fetchPage;
    this.#failureMessage = failureMessage;
  }

  /**
   * Whether the page on show reported more rows behind it.
   */
  get hasMore(): boolean {
    return this.meta?.more_data ?? false;
  }

  /**
   * Whether the list has nothing to show yet because its first page has not
   * come back. A table reads this as loading, so that it does not open on its
   * empty state.
   */
  get pending(): boolean {
    return !this.#loaded && this.error === null;
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
   * Reads the page on show again.
   */
  async load(): Promise<void> {
    await this.#loadPage(this.pageIndex, false);
  }

  /**
   * Starts again from the first page, as after a change of filter.
   */
  async restart(): Promise<void> {
    this.#cursors = [];
    this.pageIndex = 0;
    this.rows = [];
    this.meta = null;

    await this.#loadPage(0, false);
  }

  async nextPage(): Promise<void> {
    const cursor = this.meta?.oldest_id;

    if (this.loading || !this.hasMore || !cursor) {
      return;
    }

    // Recorded before the fetch, with the cursors past it dropped. Stepping
    // forward from a page that was reached by stepping back makes whatever was
    // recorded beyond it stale.
    this.#cursors = [...this.#cursors.slice(0, this.pageIndex), cursor];

    await this.#loadPage(this.pageIndex + 1, false);
  }

  async previousPage(): Promise<void> {
    if (!this.loading && this.pageIndex > 0) {
      await this.#loadPage(this.pageIndex - 1, false);
    }
  }

  /**
   * Reads the first page again without disturbing the table, for a list that
   * is being tailed. It does nothing on a later page, where new rows never
   * arrive, and it throws when the read fails.
   */
  async refresh(): Promise<void> {
    if (!this.loading && this.pageIndex === 0) {
      await this.#loadPage(0, true);
    }
  }

  async #loadPage(index: number, isQuiet: boolean): Promise<void> {
    const request = ++this.#request;

    // A quiet read leaves the loading flag and the error alone, because either
    // would swap rows that are still readable for a spinner or a banner.
    if (!isQuiet) {
      this.loading = true;
      this.error = null;
    }

    try {
      const page = await this.#fetchPage(index === 0 ? undefined : this.#cursors[index - 1]);

      // A newer request was made while this one was out, so its answer is the
      // one that counts.
      if (request !== this.#request) {
        return;
      }

      this.rows = page.data;
      this.meta = page.meta;
      this.pageIndex = index;
      this.error = null;
      this.#loaded = true;
    } catch (error) {
      if (request !== this.#request) {
        return;
      }

      if (isQuiet) {
        throw error;
      }

      this.error = error instanceof Error ? error.message : this.#failureMessage;
    } finally {
      if (request === this.#request) {
        this.loading = false;
      }
    }
  }
}
