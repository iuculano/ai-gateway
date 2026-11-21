import {
  type CreatePromptInput,
  type CreatePromptVersionInput,
  createPrompt,
  createPromptVersion,
  deletePrompt,
  deletePromptVersion,
  type ListPromptsQuery,
  listPrompts,
  listPromptVersions,
  type UpdatePromptInput,
  type UpdatePromptVersionInput,
  updatePrompt,
  updatePromptVersion,
} from '#lib/api/prompts.ts';
import type { Prompt, PromptVersionSummary } from '#lib/api/types.ts';
import { PagedList } from '#lib/state/paged-list.svelte.ts';

export type PromptStatus = NonNullable<ListPromptsQuery['status']>;

/**
 * One prompt's version list.
 */
interface VersionsState {
  rows: PromptVersionSummary[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 20;
const VERSIONS_PAGE_SIZE = 50;

const EMPTY_VERSIONS: VersionsState = { rows: [], loading: false, error: null };

/**
 * The prompts page's data, which is the prompts themselves and the versions
 * under whichever of them have been opened. Changes go to the API first, and
 * what is held here only changes once they have succeeded.
 */
class PromptsState {
  /**
   * Which prompts the list is narrowed to.
   */
  status: PromptStatus = $state('all');

  readonly list = new PagedList<Prompt>(
    (after) => listPrompts({ limit: PAGE_SIZE, status: this.status, after_id: after }),
    'Failed to load prompts.',
  );

  /**
   * Version lists by prompt id, fetched when a prompt is opened and not up
   * front. A page of prompts would otherwise be a request each for lists that
   * are only read for the row the reader has opened or is previewing.
   */
  versions: Record<string, VersionsState> = $state({});

  /**
   * The version list for a prompt, or an empty one when it has not been
   * fetched.
   */
  versionsFor(id: string): VersionsState {
    return this.versions[id] ?? EMPTY_VERSIONS;
  }

  async ensureLoaded(): Promise<void> {
    await this.list.ensureLoaded();
  }

  /**
   * Narrows the list to one status, starting from its first page.
   */
  async filterByStatus(status: PromptStatus): Promise<void> {
    this.status = status;

    await this.list.restart();
  }

  /**
   * Reads the prompts again, and any version list already on show.
   */
  async refresh(): Promise<void> {
    // The version lists are read again and not dropped, because dropping them
    // would collapse the open row's panel to a spinner on every refresh.
    const opened = Object.keys(this.versions);

    await Promise.all([this.list.load(), ...opened.map((id) => this.loadVersions(id))]);
  }

  /**
   * Fetches a prompt's versions once. Later calls do nothing.
   */
  async ensureVersions(id: string): Promise<void> {
    if (!this.versions[id]) {
      await this.loadVersions(id);
    }
  }

  async loadVersions(id: string): Promise<void> {
    const existing = this.versions[id];

    if (existing?.loading) {
      return;
    }

    const rows = existing?.rows ?? [];

    this.versions[id] = { rows: rows, loading: true, error: null };

    try {
      const page = await listPromptVersions(id, { limit: VERSIONS_PAGE_SIZE });

      this.versions[id] = { rows: page.data, loading: false, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load versions.';

      this.versions[id] = { rows: rows, loading: false, error: message };
    }
  }

  async create(input: CreatePromptInput): Promise<Prompt> {
    const created = await createPrompt(input);

    await this.list.restart();

    return created;
  }

  async update(id: string, input: UpdatePromptInput): Promise<Prompt> {
    const updated = await updatePrompt(id, input);

    this.list.rows = this.list.rows.map((prompt) => (prompt.id === id ? updated : prompt));
    await this.list.load();

    return updated;
  }

  /**
   * Deletes a prompt and everything under it.
   */
  async remove(id: string): Promise<void> {
    await deletePrompt(id);

    // The cached versions go too. They are deleted along with the prompt, so
    // keeping them would show versions of something that no longer exists.
    this.list.rows = this.list.rows.filter((prompt) => prompt.id !== id);
    delete this.versions[id];

    await this.list.load();

    // Deleting the last row of a later page leaves that page empty.
    if (this.list.rows.length === 0 && this.list.pageIndex > 0) {
      await this.list.previousPage();
    }
  }

  /**
   * Adds a version to a prompt.
   */
  async addVersion(id: string, input: CreatePromptVersionInput): Promise<PromptVersionSummary> {
    const created = await createPromptVersion(id, input);
    const existing = this.versionsFor(id);

    this.versions[id] = { ...existing, rows: [created, ...existing.rows] };

    // The service makes a prompt's first version its active one. The row is
    // patched to match, so that it does not read as unversioned until the next
    // refresh.
    const wasUnversioned = this.list.rows.find((prompt) => prompt.id === id)?.active_version == null;

    if (wasUnversioned) {
      this.list.rows = this.list.rows.map((prompt) =>
        prompt.id === id ? { ...prompt, active_version: created.version } : prompt,
      );
      await this.list.load();
    }

    return created;
  }

  async editVersion(id: string, version: number, input: UpdatePromptVersionInput): Promise<void> {
    const updated = await updatePromptVersion(id, version, input);
    const existing = this.versionsFor(id);

    this.versions[id] = {
      ...existing,
      rows: existing.rows.map((row) => (row.version === version ? { ...row, ...updated } : row)),
    };
  }

  async removeVersion(id: string, version: number): Promise<void> {
    await deletePromptVersion(id, version);

    const existing = this.versionsFor(id);

    this.versions[id] = { ...existing, rows: existing.rows.filter((row) => row.version !== version) };
  }

  /**
   * Points a prompt at a different version.
   */
  async setActiveVersion(id: string, version: number): Promise<void> {
    await this.update(id, { active_version: version });
  }
}

export const prompts = new PromptsState();
