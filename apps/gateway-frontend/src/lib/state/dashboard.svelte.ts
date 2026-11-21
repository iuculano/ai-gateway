import {
  type ApiKeyStatus,
  type CreateApiKeyInput,
  countApiKeys,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type UpdateApiKeyInput,
  updateApiKey,
} from '#lib/api/api-keys.ts';
import type { ApiKey, CreatedApiKey } from '#lib/api/types.ts';
import { PagedList } from '#lib/state/paged-list.svelte.ts';

const PAGE_SIZE = 20;
const STATUSES: ApiKeyStatus[] = ['all', 'active', 'expired', 'revoked'];

/**
 * The API keys and how many there are of each status, with the search the top
 * bar shares between pages. Changes go to the API first, and what is held here
 * only changes once they have succeeded.
 */
class DashboardState {
  /**
   * What is typed into the top bar's search box. Whichever page is open
   * filters its own rows by it.
   */
  search = $state('');

  readonly keys = new PagedList<ApiKey>(
    (after) => listApiKeys(this.#status, { limit: PAGE_SIZE, after_id: after }),
    'Failed to load API keys.',
  );

  counts: Partial<Record<ApiKeyStatus, Awaited<ReturnType<typeof countApiKeys>>>> = $state({});
  countErrors: Partial<Record<ApiKeyStatus, string>> = $state({});

  #status: ApiKeyStatus = 'all';
  #countRequests: Partial<Record<ApiKeyStatus, number>> = {};
  #countsLoaded = false;

  /**
   * Counts the keys of each status again.
   */
  async refreshCounts(statuses: ApiKeyStatus[] = STATUSES): Promise<void> {
    await Promise.all(statuses.map((status) => this.#refreshCount(status)));

    this.#countsLoaded = true;
  }

  async #refreshCount(status: ApiKeyStatus): Promise<void> {
    // The newest request for a status wins, as with the list itself.
    const request = (this.#countRequests[status] ?? 0) + 1;

    this.#countRequests[status] = request;
    this.countErrors[status] = undefined;

    try {
      const result = await countApiKeys(status);

      if (request === this.#countRequests[status]) {
        this.counts[status] = result;
      }
    } catch (error) {
      if (request === this.#countRequests[status]) {
        this.counts[status] = undefined;
        this.countErrors[status] = error instanceof Error ? error.message : 'Failed to load key counts.';
      }
    }
  }

  /**
   * Narrows the list to one status, starting from its first page.
   */
  async filterByStatus(status: ApiKeyStatus): Promise<void> {
    this.#status = status;

    // Every count is wanted the first time, and afterwards only the one for
    // the status being looked at.
    const counted = this.#countsLoaded ? [status] : STATUSES;

    await Promise.all([this.keys.restart(), this.refreshCounts(counted)]);
  }

  async refresh(): Promise<void> {
    await Promise.all([this.keys.load(), this.refreshCounts()]);
  }

  /**
   * Makes a key and returns it with its secret, which is shown the one time.
   */
  async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const created = await createApiKey(input);

    await Promise.all([this.keys.restart(), this.refreshCounts()]);

    return created;
  }

  async revoke(id: string): Promise<void> {
    await revokeApiKey(id);

    // Marked revoked at once, and then read again for the server's own time of
    // revocation and who is accountable for it.
    const revokedAt = new Date().toISOString();

    this.keys.rows = this.keys.rows.map((key) => (key.id === id ? { ...key, revoked_at: revokedAt } : key));

    await this.refresh();
  }

  async update(id: string, input: UpdateApiKeyInput): Promise<void> {
    const updated = await updateApiKey(id, input);

    // The request count is carried over. Only the list endpoint fills it in,
    // so putting the bare updated row in would blank the Requests cell.
    this.keys.rows = this.keys.rows.map((key) =>
      key.id === id ? { ...updated, total_requests: key.total_requests } : key,
    );

    await this.refreshCounts();
  }
}

export const dashboard = new DashboardState();
