import { type ListPromptsQuery, listPrompts } from '$lib/api/prompts';
import type { ListMeta, Prompt } from '$lib/api/types';

export type PromptStatus = NonNullable<ListPromptsQuery['status']>;

/** One server-filtered page, with cursors retained for Newer navigation. */
export class PromptList {
  rows: Prompt[] = $state([]);
  meta: ListMeta | null = $state(null);
  loading = $state(false);
  error: string | null = $state(null);
  pageIndex = $state(0);
  status: PromptStatus = $state('all');
  #cursors: string[] = [];
  #request = 0;
  #loaded = false;

  get hasMore(): boolean {
    return this.meta?.more_data ?? false;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.#loaded && !this.loading) await this.load();
  }

  async filterByStatus(status: PromptStatus): Promise<void> {
    this.status = status;
    this.#cursors = [];
    this.pageIndex = 0;
    this.rows = [];
    this.meta = null;
    await this.loadPage(0);
  }

  async load(): Promise<void> {
    await this.loadPage(this.pageIndex);
  }

  async firstPage(): Promise<void> {
    await this.filterByStatus(this.status);
  }

  async nextPage(): Promise<void> {
    if (this.loading || !this.hasMore || !this.meta?.oldest_id) return;
    this.#cursors = [...this.#cursors.slice(0, this.pageIndex), this.meta.oldest_id];
    await this.loadPage(this.pageIndex + 1);
  }

  async previousPage(): Promise<void> {
    if (this.loading || this.pageIndex === 0) return;
    await this.loadPage(this.pageIndex - 1);
  }

  async refresh(): Promise<void> {
    if (!this.loading && this.pageIndex === 0) await this.loadPage(0, true);
  }

  private async loadPage(index: number, silent = false): Promise<void> {
    const request = ++this.#request;
    this.loading = !silent;
    if (!silent) this.error = null;
    try {
      const result = await listPrompts({
        limit: 20,
        status: this.status,
        after_id: index === 0 ? undefined : this.#cursors[index - 1],
      });
      if (request !== this.#request) return;
      this.rows = result.data;
      this.meta = result.meta;
      this.pageIndex = index;
      this.#loaded = true;
      this.error = null;
    } catch (error) {
      if (request !== this.#request) return;
      if (silent) throw error;
      this.error = error instanceof Error ? error.message : 'Failed to load prompts.';
    } finally {
      if (request === this.#request) this.loading = false;
    }
  }
}
