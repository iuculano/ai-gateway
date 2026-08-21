import { type CreateApiKeyInput, createApiKey, listApiKeys, revokeApiKey, updateApiKey } from '$lib/api/api-keys';
import type { ApiKey, CreatedApiKey } from '$lib/api/types';

// Client-side cache of the dashboard's data, backed by the BFF proxy.
// Mutations go to the API first; local state only changes on success.
class DashboardState {
  keys: ApiKey[] = $state([]);
  loading = $state(false);
  error: string | null = $state(null);
  search = $state('');

  #loaded = false;

  /** Fetches the key list once; later calls are no-ops. Use refresh() to force. */
  async ensureLoaded(): Promise<void> {
    if (!this.#loaded && !this.loading) {
      await this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (this.loading) return; // Don't stack overlapping fetches.
    this.loading = true;
    this.error = null;

    try {
      const result = await listApiKeys();
      this.keys = result.data;
      this.#loaded = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load API keys.';
    } finally {
      this.loading = false;
    }
  }

  /**
   * Re-reads the keys without disturbing the table.
   *
   * The quiet twin of refresh(): no loading flag, so the rows stay put instead
   * of blanking to a spinner, and no error assignment, so a failed tick does
   * not raise a banner over a table that is still readable. It throws, and
   * AutoRefresh switches itself off on the way past.
   */
  async refreshQuietly(): Promise<void> {
    if (this.loading) return;

    const result = await listApiKeys();
    this.keys = result.data;
  }

  /** Creates a key and returns it including the plaintext (shown once). */
  async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const created = await createApiKey(input);

    // The create response carries no count - it is a fresh key, so 0 is the
    // real figure rather than a placeholder, and stating it keeps the new row's
    // Requests cell consistent with every other row instead of showing an em dash.
    const { key: _key, ...row } = created;
    this.keys = [{ ...row, total_requests: 0 }, ...this.keys];

    return created;
  }

  async revoke(id: string): Promise<void> {
    await revokeApiKey(id);
    this.keys = this.keys.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k));
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
