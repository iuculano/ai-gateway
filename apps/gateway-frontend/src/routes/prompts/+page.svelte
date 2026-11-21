<script lang="ts">
import { onMount } from 'svelte';
import type { Prompt } from '#lib/api/types.ts';
import AutoRefreshToggle from '#lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import Pager from '#lib/components/app/pager.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import PreviewDialog from '#lib/components/prompts/preview-dialog.svelte';
import PromptDialog from '#lib/components/prompts/prompt-dialog.svelte';
import PromptRow from '#lib/components/prompts/prompt-row.svelte';
import VersionDialog from '#lib/components/prompts/version-dialog.svelte';
import { pairSummary } from '#lib/data/format.ts';
import { tagKeys } from '#lib/data/prompts.ts';
import { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';
import { type PromptStatus, prompts } from '#lib/state/prompts.svelte.ts';

// Shared with PromptRow, so that the header and the rows sit in one grid.
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

const TABS = [
  { id: 'all' as const, label: 'All' },
  { id: 'versioned' as const, label: 'Versioned', color: '#10b981' },
  { id: 'unversioned' as const, label: 'Unversioned', color: '#f59e0b' },
];

const auto = new AutoRefresh();
const list = prompts.list;

let expandedRow: string | null = $state(null);
let promptDialogOpen = $state(false);
let versionDialogOpen = $state(false);
let previewOpen = $state(false);

// The row the prompt dialog is editing, or null when it is making a new one.
let editing: Prompt | null = $state(null);

// The prompt the version and preview dialogs are working on. It is held apart
// from `editing`, because those two stay open over a row that may be edited
// underneath them and need its id and name after the row has been collapsed.
let subject: Prompt | null = $state(null);

// The version the editor is rewriting, or null when it is adding a new one.
let editingVersion: number | null = $state(null);

const query = $derived(dashboard.search.trim().toLowerCase());

const filtered = $derived(
  list.rows.filter(
    (prompt) =>
      !query || `${prompt.name} ${prompt.description ?? ''} ${pairSummary(prompt.tags)}`.toLowerCase().includes(query),
  ),
);

const versioned = $derived(list.rows.filter((prompt) => prompt.active_version != null).length);
const unversioned = $derived(list.rows.length - versioned);
const distinctTags = $derived(tagKeys(list.rows.map((prompt) => prompt.tags)).length);

// The preview opens on the subject's active version, so it reads the row as it
// is now and not the copy taken when the button was pressed. Activating a
// version from the panel behind it would otherwise go unnoticed.
const subjectRow = $derived.by(() => {
  const current = subject;

  if (current === null) {
    return null;
  }

  return list.rows.find((prompt) => prompt.id === current.id) ?? current;
});

function setStatus(status: PromptStatus): void {
  expandedRow = null;

  void prompts.filterByStatus(status);
}

function openCreate(): void {
  editing = null;
  promptDialogOpen = true;
}

function openEdit(prompt: Prompt): void {
  editing = prompt;
  promptDialogOpen = true;
}

function openNewVersion(prompt: Prompt): void {
  subject = prompt;
  editingVersion = null;
  versionDialogOpen = true;
}

function openEditVersion(prompt: Prompt, version: number): void {
  subject = prompt;
  editingVersion = version;
  versionDialogOpen = true;
}

function openPreview(prompt: Prompt): void {
  subject = prompt;
  previewOpen = true;
}

// A row that was open belongs to the page it was on.
$effect(() => {
  void list.pageIndex;
  expandedRow = null;
});

$effect(() => auto.schedule(list.pageIndex === 0, () => list.refresh()));

// Loaded once on mount and not in an effect, which would run again whenever
// the load changed its own state.
onMount(() => {
  void prompts.ensureLoaded();
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

<TableCard
	cols={COLS}
	columns={COLUMNS}
	loading={list.loading && list.rows.length === 0}
	error={list.error}
	isEmpty={filtered.length === 0}
	loadingLabel="Loading prompts…"
	emptyTitle={list.rows.length === 0 && list.pageIndex === 0 && prompts.status === 'all' ? 'No prompts yet' : 'No prompts match on this page'}
	emptyHint={list.rows.length === 0 && list.pageIndex === 0 && prompts.status === 'all'
		? 'Create a prompt, then add a version to give it text.'
		: undefined}
	onretry={() => list.load()}
	showFooter={list.pageIndex > 0 || list.hasMore}
>
	{#snippet toolbar()}
		<FilterTabs tabs={TABS} bind:value={() => prompts.status, setStatus} />
		<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
			<span class="font-medium text-zinc-100 tabular-nums">{filtered.length.toLocaleString()}</span>
			of <span class="font-medium text-zinc-200 tabular-nums">{list.rows.length.toLocaleString()}</span> prompts on this page
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-emerald-400 tabular-nums">{versioned.toLocaleString()}</span> versioned
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-amber-400 tabular-nums">{unversioned.toLocaleString()}</span> unversioned
			<span class="mx-1 text-zinc-600">·</span>
			<span class="font-medium text-zinc-200 tabular-nums">{distinctTags.toLocaleString()}</span> tag keys
		</span>

		<span class="ml-auto"></span>

		<AutoRefreshToggle {auto} active={list.pageIndex === 0} pausedLabel="paused past page 1" />

		<RefreshButton disabled={list.loading} onclick={() => prompts.refresh()} />
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
		<Pager list={list} />
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
