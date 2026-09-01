import {
  type CreatePromptInput,
  type CreatePromptVersionInput,
  createPrompt,
  createPromptVersion,
  deletePrompt,
  deletePromptVersion,
  listPrompts,
  listPromptVersions,
  type UpdatePromptInput,
  type UpdatePromptVersionInput,
  updatePrompt,
  updatePromptVersion,
} from '$lib/api/prompts';
import type { Prompt, PromptVersionSummary } from '$lib/api/types';
import { CursorList } from './cursor-list.svelte';

const PAGE_SIZE = 50;

/** One prompt's version list. */
interface VersionsState {
  rows: PromptVersionSummary[];
  loading: boolean;
  error: string | null;
}

const EMPTY_VERSIONS: VersionsState = { rows: [], loading: false, error: null };

/**
 * The prompts page's data: the prompts themselves, and the versions under
 * whichever ones have been opened.
 *
 * Versions are keyed by prompt id and fetched on demand rather than up front.
 * A page of 50 prompts is 50 more requests if they are all loaded eagerly, and
 * the list is only ever read for the row the user has actually expanded or is
 * previewing.
 *
 * Mutations go to the API first; local state only changes on success.
 */
class PromptsState {
  readonly list = new CursorList<Prompt>(
    (after) => listPrompts({ limit: PAGE_SIZE, after_id: after }),
    'Failed to load prompts.',
  );

  /**
   * Version lists, by prompt id.
   *
   * A plain object rather than a Map: `$state` deep-proxies objects and arrays,
   * so assigning into it is reactive, and a Map is not without SvelteMap.
   */
  versions: Record<string, VersionsState> = $state({});

  /** The version list for a prompt, or an empty one if it has not been fetched. */
  versionsFor(id: string): VersionsState {
    return this.versions[id] ?? EMPTY_VERSIONS;
  }

  async ensureLoaded(): Promise<void> {
    await this.list.ensureLoaded();
  }

  /**
   * Re-reads the prompts, and any version list already on screen.
   *
   * The version lists are refetched rather than dropped: discarding them would
   * collapse the open row's panel to a spinner on every refresh.
   */
  async refresh(): Promise<void> {
    const opened = Object.keys(this.versions);

    await Promise.all([this.list.load(), ...opened.map((id) => this.loadVersions(id))]);
  }

  /** Fetches a prompt's versions once; later calls are no-ops. */
  async ensureVersions(id: string): Promise<void> {
    if (this.versions[id]) return;

    await this.loadVersions(id);
  }

  async loadVersions(id: string): Promise<void> {
    const existing = this.versions[id];
    if (existing?.loading) return;

    this.versions[id] = { rows: existing?.rows ?? [], loading: true, error: null };

    try {
      const page = await listPromptVersions(id, { limit: PAGE_SIZE });
      this.versions[id] = { rows: page.data, loading: false, error: null };
    } catch (error) {
      this.versions[id] = {
        rows: existing?.rows ?? [],
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load versions.',
      };
    }
  }

  async create(input: CreatePromptInput): Promise<Prompt> {
    const created = await createPrompt(input);
    this.list.rows = [created, ...this.list.rows];

    return created;
  }

  async update(id: string, input: UpdatePromptInput): Promise<Prompt> {
    const updated = await updatePrompt(id, input);
    this.list.rows = this.list.rows.map((prompt) => (prompt.id === id ? updated : prompt));

    return updated;
  }

  /**
   * Deletes a prompt and everything under it.
   *
   * The cached version list goes too - prompt_versions.prompt_id cascades, so
   * keeping it would be showing versions of a prompt that no longer exists.
   */
  async remove(id: string): Promise<void> {
    await deletePrompt(id);

    this.list.rows = this.list.rows.filter((prompt) => prompt.id !== id);
    delete this.versions[id];
  }

  /**
   * Adds a version, and reflects the activation the server may have performed.
   *
   * The first version of a prompt is activated on creation by the service, so
   * the prompt row is patched locally to match rather than left showing
   * "unversioned" until the next refresh.
   */
  async addVersion(id: string, input: CreatePromptVersionInput): Promise<PromptVersionSummary> {
    const created = await createPromptVersion(id, input);
    const existing = this.versionsFor(id);

    this.versions[id] = { ...existing, rows: [created, ...existing.rows] };

    const wasUnversioned = this.list.rows.find((prompt) => prompt.id === id)?.active_version == null;
    if (wasUnversioned) {
      this.patch(id, { active_version: created.version });
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

  /** Points the prompt at a different version. */
  async setActiveVersion(id: string, version: number): Promise<void> {
    await this.update(id, { active_version: version });
  }

  /** Local-only patch of a prompt row, for state the server already applied. */
  private patch(id: string, fields: Partial<Prompt>): void {
    this.list.rows = this.list.rows.map((prompt) => (prompt.id === id ? { ...prompt, ...fields } : prompt));
  }
}

export const prompts = new PromptsState();
