<script lang="ts">
import { onMount } from 'svelte';
import type { Prompt } from '$lib/api/types';
import AutoRefreshToggle from '$lib/components/app/auto-refresh-toggle.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import PreviewDialog from '$lib/components/prompts/preview-dialog.svelte';
import PromptDialog from '$lib/components/prompts/prompt-dialog.svelte';
import PromptRow from '$lib/components/prompts/prompt-row.svelte';
import VersionDialog from '$lib/components/prompts/version-dialog.svelte';
import { pairSummary } from '$lib/data/format';
import { tagKeys } from '$lib/data/prompts';
import { AutoRefresh } from '$lib/state/auto-refresh.svelte';
import { dashboard } from '$lib/state/dashboard.svelte';
import { prompts } from '$lib/state/prompts.svelte';

// One grid, shared with the row component so the header and the rows sit in
// the same grid - the same contract the other tables use.
const COLS = '24px minmax(150px,1.3fr) minmax(150px,1.4fr) minmax(120px,1fr) 104px 112px 214px';

const COLUMNS = [
  { label: '' },
  { label: 'Name' },
  { label: 'Description' },
  { label: 'Tags' },
  { label: 'Active' },
  { label: 'Updated' },
  { label: 'Actions', align: 'right' as const },
];

let expandedRow: string | null = $state(null);

let promptDialogOpen = $state(false);

/** The row the prompt dialog is editing; null puts it in create mode. */
let editing: Prompt | null = $state(null);

let versionDialogOpen = $state(false);
let previewOpen = $state(false);

/**
 * The prompt the version and preview dialogs are working on.
 *
 * Held separately from `editing` because those two stay open over a row that
 * may be edited underneath them, and because both need the prompt's id and name
 * after the row itself has been collapsed.
 */
let subject: Prompt | null = $state(null);

/** The version the editor is rewriting; null appends a new one. */
let editingVersion: number | null = $state(null);

// Load once on mount - NOT $effect, which would re-run whenever a load mutates
// its own loading flag and hammer the endpoint on any error.
const auto = new AutoRefresh();

// Paused once the reader has paged past the head: refresh() re-reads the first
// page only, so tailing would drop everything Load more appended.
$effect(() => auto.schedule(!prompts.list.appended, () => prompts.list.refresh()));

onMount(() => {
  prompts.ensureLoaded();
});

function openCreate() {
  editing = null;
  promptDialogOpen = true;
}

function openEdit(prompt: Prompt) {
  editing = prompt;
  promptDialogOpen = true;
}

function openNewVersion(prompt: Prompt) {
  subject = prompt;
  editingVersion = null;
  versionDialogOpen = true;
}

function openEditVersion(prompt: Prompt, version: number) {
  subject = prompt;
  editingVersion = version;
  versionDialogOpen = true;
}

function openPreview(prompt: Prompt) {
  subject = prompt;
  previewOpen = true;
}

// The topbar's search box, shared by every page.
const query = $derived(dashboard.search.trim().toLowerCase());

const filtered = $derived(
  prompts.list.rows.filter(
    (prompt) =>
      !query || `${prompt.name} ${prompt.description ?? ''} ${pairSummary(prompt.tags)}`.toLowerCase().includes(query),
  ),
);

const versioned = $derived(prompts.list.rows.filter((prompt) => prompt.active_version != null).length);
const unversioned = $derived(prompts.list.rows.length - versioned);
const distinctTags = $derived(tagKeys(prompts.list.rows.map((prompt) => prompt.tags)).length);

/**
 * The preview dialog opens on the subject's active version, so it has to read
 * the live row rather than the copy captured when the button was pressed -
 * activating a version from the panel behind it would otherwise be ignored.
 */
const subjectRow = $derived.by(() => {
  // Copied to a const first: `subject` is mutable state, so the null check
  // above does not narrow it inside the callback below.
  const current = subject;
  if (current === null) return null;

  return prompts.list.rows.find((prompt) => prompt.id === current.id) ?? current;
});
</script>

<PageHeader
	title="Prompts"
	description="Versioned, templated prompts your services resolve by name."
>
	{#snippet actions()}
		<ToolbarButton variant="primary" onclick={openCreate}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 3.3v9.4M3.3 8h9.4" stroke="#04130d" stroke-width="1.8" stroke-linecap="round" /></svg>
			Create prompt
		</ToolbarButton>
	{/snippet}
</PageHeader>

<StatGrid>
	<StatCard
		label="Prompts"
		value={prompts.list.rows.length}
		hint={prompts.list.hasMore ? 'first page' : undefined}
	/>
	<StatCard label="Versioned" value={versioned} accent="#10b981" />
	<!-- A prompt with no active version cannot be resolved by a caller at all, so
	     this is a count of things that are configured but not yet usable. -->
	<StatCard label="Unversioned" value={unversioned} accent="#f59e0b" />
	<StatCard label="Tag keys" value={distinctTags} />
</StatGrid>

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={prompts.list.loading && prompts.list.rows.length === 0}
	error={prompts.list.error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading prompts…"
	emptyTitle={prompts.list.rows.length === 0 ? 'No prompts yet' : 'No prompts match your search'}
	emptyHint={prompts.list.rows.length === 0
		? 'Create a prompt, then add a version to give it text.'
		: undefined}
	onretry={() => prompts.list.load()}
	showFooter={prompts.list.hasMore}
>
	{#snippet toolbar()}
		<span class="text-[12.5px] text-zinc-600">
			{filtered.length} of {prompts.list.rows.length} prompts{prompts.list.hasMore ? ' loaded' : ''}
		</span>

		<span class="ml-auto flex items-center gap-[7px] text-[12.5px] text-zinc-600">
			<span class="size-[5px] rounded-full bg-zinc-700"></span>
			Callers resolve the active version unless they name one
		</span>

		<AutoRefreshToggle {auto} active={!prompts.list.appended} pausedLabel="paused past page 1" />

		<ToolbarButton disabled={prompts.list.loading} onclick={() => prompts.refresh()}>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Refresh
		</ToolbarButton>
	{/snippet}

	{#each filtered as prompt (prompt.id)}
		<PromptRow
			{prompt}
			cols={COLS}
			expanded={expandedRow === prompt.id}
			ontoggle={() => (expandedRow = expandedRow === prompt.id ? null : prompt.id)}
			onedit={() => openEdit(prompt)}
			onpreview={() => openPreview(prompt)}
			onnewversion={() => openNewVersion(prompt)}
			oneditversion={(version) => openEditVersion(prompt, version)}
		/>
	{/each}

	{#snippet footer()}
		<ToolbarButton disabled={prompts.list.loadingMore} onclick={() => prompts.list.loadMore()}>
			{prompts.list.loadingMore ? 'Loading…' : 'Load older prompts'}
		</ToolbarButton>
	{/snippet}
</TableCard>

<PromptDialog bind:open={promptDialogOpen} prompt={editing} />

{#if subjectRow}
	<VersionDialog
		bind:open={versionDialogOpen}
		promptId={subjectRow.id}
		promptName={subjectRow.name}
		version={editingVersion}
	/>

	<PreviewDialog
		bind:open={previewOpen}
		promptId={subjectRow.id}
		promptName={subjectRow.name}
		activeVersion={subjectRow.active_version ?? null}
	/>
{/if}
