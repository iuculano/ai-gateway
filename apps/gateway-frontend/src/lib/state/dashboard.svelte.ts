import {
  type ApiKeyStatus,
  type CreateApiKeyInput,
  countApiKeys,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type UpdateApiKeyInput,
  updateApiKey,
} from '$lib/api/api-keys';
import type { ApiKey, CreatedApiKey, ListMeta } from '$lib/api/types';

// Client-side cache of the dashboard's data, backed by the BFF proxy.
// Mutations go to the API first; local state only changes on success.
class DashboardState {
  keys: ApiKey[] = $state([]);
  loading = $state(false);
  error: string | null = $state(null);
  search = $state('');

  counts: Partial<Record<ApiKeyStatus, Awaited<ReturnType<typeof countApiKeys>>>> = $state({});
  countErrors: Partial<Record<ApiKeyStatus, string>> = $state({});
  #countRequests: Partial<Record<ApiKeyStatus, number>> = {};

  async refreshCounts(statuses: ApiKeyStatus[] = ['all', 'active', 'expired', 'revoked']): Promise<void> {
    await Promise.all(
      statuses.map(async (status) => {
        const request = (this.#countRequests[status] ?? 0) + 1;
        this.#countRequests[status] = request;
        this.countErrors[status] = undefined;
        try {
          const result = await countApiKeys(status);
          if (request === this.#countRequests[status]) this.counts[status] = result;
        } catch (error) {
          if (request !== this.#countRequests[status]) return;
          this.counts[status] = undefined;
          this.countErrors[status] = error instanceof Error ? error.message : 'Failed to load key counts.';
        }
      }),
    );
  }

  #loaded = false;
  #request = 0;
  #cursors: string[] = [];
  #status: 'all' | 'active' | 'expired' | 'revoked' = 'all';
  pageIndex = $state(0);
  meta: ListMeta | null = $state(null);

  /** Fetches the key list once; later calls are no-ops. Use refresh() to force. */
  async ensureLoaded(): Promise<void> {
    if (!this.#loaded && !this.loading) {
      await this.refresh();
    }
  }

  async filterByStatus(status: 'all' | 'active' | 'expired' | 'revoked'): Promise<void> {
    this.#status = status;
    this.#cursors = [];
    this.pageIndex = 0;
    this.keys = [];
    this.meta = null;
    // A filter change supersedes any in-flight page request.
    this.loading = false;
    await Promise.all([this.loadPage(0), this.refreshCounts(this.#loaded ? [status] : undefined)]);
  }

  async refresh(): Promise<void> {
    await Promise.all([this.loadPage(this.pageIndex), this.refreshCounts()]);
  }

  async nextPage(): Promise<void> {
    if (this.loading || !this.meta?.more_data || !this.meta.oldest_id) return;
    this.#cursors = [...this.#cursors.slice(0, this.pageIndex), this.meta.oldest_id];
    await this.loadPage(this.pageIndex + 1);
  }

  async previousPage(): Promise<void> {
    if (this.loading || this.pageIndex === 0) return;
    await this.loadPage(this.pageIndex - 1);
  }

  private async loadPage(index: number, silent = false): Promise<void> {
    if (this.loading) return;
    const request = ++this.#request;
    if (!silent) {
      this.loading = true;
      this.error = null;
    }
    try {
      const result = await listApiKeys(this.#status, {
        limit: 20,
        after_id: index === 0 ? undefined : this.#cursors[index - 1],
      });
      if (request !== this.#request) return;
      this.keys = result.data;
      this.meta = result.meta;
      this.pageIndex = index;
      this.#loaded = true;
      this.error = null;
    } catch (error) {
      if (request !== this.#request) return;
      if (silent) throw error;
      this.error = error instanceof Error ? error.message : 'Failed to load API keys.';
    } finally {
      if (request === this.#request) this.loading = false;
    }
  }

  /** Auto-refresh follows only the newest page and leaves the table visible. */
  async refreshQuietly(): Promise<void> {
    if (this.pageIndex === 0) await this.loadPage(0, true);
  }

  /** Creates a key and returns it including the plaintext (shown once). */
  async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const created = await createApiKey(input);

    await Promise.all([this.loadPage(0), this.refreshCounts()]);

    return created;
  }

  async revoke(id: string): Promise<void> {
    await revokeApiKey(id);
    this.keys = this.keys.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k));
    // Fetch the server's revocation timestamp and accountable user.
    await this.refresh();
  }

  /**
   * Permanently deletes a key.
   *
   * TODO: the backend is revoke-only (soft delete) by design - there is no
   * hard-delete endpoint yet. Wire this to it once the contract is decided;
   * until then it reports that the action is unavailable.
   */
  async remove(_id: string): Promise<void> {
    throw new Error('Deleting keys is not available yet — revoke the key instead.');
  }

  /** Applies edits while preserving the list-only usage count. */
  async update(id: string, input: UpdateApiKeyInput): Promise<void> {
    const updated = await updateApiKey(id, input);
    this.keys = this.keys.map((k) => (k.id === id ? { ...updated, total_requests: k.total_requests } : k));
    await this.refreshCounts();
  }

  /** Replaces a key's scopes; takes the UI's array form, stores space-delimited. */
  async setScopes(id: string, scopes: string[]): Promise<void> {
    const updated = await updateApiKey(id, { scopes: scopes.join(' ') });

    // total_requests is carried over rather than taken from the response: only
    // the list endpoint hydrates it, so swapping in the bare updated row would
    // blank the Requests cell every time a scope is toggled.
    this.keys = this.keys.map((k) => (k.id === id ? { ...updated, total_requests: k.total_requests } : k));
  }
}

export const dashboard = new DashboardState();
