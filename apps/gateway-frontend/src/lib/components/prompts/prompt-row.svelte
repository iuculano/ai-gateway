<script lang="ts">
import { toast } from 'svelte-sonner';
import type { Prompt } from '$lib/api/types';
import ConfirmDialog from '$lib/components/app/confirm-dialog.svelte';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import { fmtTs, formatDate, initialsOf, pairSummary } from '$lib/data/format';
import { prompts as store } from '$lib/state/prompts.svelte';

let {
  prompt,
  cols,
  expanded,
  ontoggle,
  onedit,
  onpreview,
  onnewversion,
  oneditversion,
}: {
  prompt: Prompt;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
  onedit: () => void;
  onpreview: () => void;
  onnewversion: () => void;
  oneditversion: (version: number) => void;
} = $props();

const TONES = ['#10b981', '#60a5fa', '#c084fc', '#f59e0b', '#34d399'];

const p = $derived(prompt);

// Same deterministic tone as the keys and webhooks tables, so a prompt keeps
// its colour across renders and sorts.
const tone = $derived(TONES[[...p.id].reduce((acc, char) => acc + char.charCodeAt(0), 0) % TONES.length]);

const versions = $derived(store.versionsFor(p.id));
const created = $derived(fmtTs(p.created_at));
const updated = $derived(fmtTs(p.updated_at));

const detailItems: DetailItem[] = $derived([
  { label: 'Prompt ID', value: p.id },
  { label: 'Created', value: created.full },
  { label: 'Last updated', value: updated.full },
  { label: 'Description', value: p.description ?? '—', mono: false },
  { label: 'Tags', value: pairSummary(p.tags), title: pairSummary(p.tags) },
  {
    label: 'Active version',
    value: p.active_version == null ? 'none' : `v${p.active_version}`,
    mono: false,
  },
]);

// Fetched when the row opens rather than with the page: a page of prompts
// would otherwise be a page of extra requests, for panels nobody looked at.
$effect(() => {
  if (expanded) {
    void store.ensureVersions(p.id);
  }
});

let busy = $state(false);
let confirmDeleteOpen = $state(false);

// The version awaiting confirmation, and the dialog's own open flag. Two pieces
// of state rather than deriving `open` from the number: ConfirmDialog closes
// itself by writing to `open`, so it has to be bound to something writable -
// and the number is deliberately left set while the dialog animates out, or the
// title flashes "Delete version null?" on the way.
let confirmVersionOpen = $state(false);
let versionToDelete: number | null = $state(null);

function askDeleteVersion(version: number) {
  versionToDelete = version;
  confirmVersionOpen = true;
}

async function remove() {
  busy = true;

  try {
    await store.remove(p.id);
    toast.success('Prompt deleted');
    confirmDeleteOpen = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to delete the prompt.');
  } finally {
    busy = false;
  }
}

async function removeVersion() {
  if (versionToDelete === null) return;

  busy = true;

  try {
    await store.removeVersion(p.id, versionToDelete);
    toast.success(`Version ${versionToDelete} deleted`);
    confirmVersionOpen = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to delete the version.');
  } finally {
    busy = false;
  }
}

async function activate(version: number) {
  busy = true;

  try {
    await store.setActiveVersion(p.id, version);
    toast.success(`v${version} is now active`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to change the active version.');
  } finally {
    busy = false;
  }
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<!-- A tone dot rather than an initials block. The 32px avatar was the
			     tallest thing in the row and set the row height on its own; this keeps
			     the same deterministic colour at the height logs' rows run at. -->
			<span class="size-[7px] flex-none rounded-full" style:background={tone}></span>
			<span class="overflow-hidden font-mono text-[13px] font-medium text-ellipsis whitespace-nowrap">{p.name}</span>
		</span>

		<!-- Lifted out from under the name, where it made every row two lines tall. -->
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-500">
			{p.description ?? '—'}
		</span>

		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-400" title={pairSummary(p.tags)}>
			{pairSummary(p.tags)}
		</span>

		<!-- A prompt with no active version cannot be resolved by a caller at all,
		     which is worth saying outright rather than leaving the cell blank. -->
		{#if p.active_version == null}
			<span class="text-[12.5px] text-amber-400/90">Unversioned</span>
		{:else}
			<span class="rounded-[5px] bg-emerald-500/12 px-1.5 py-px text-center text-[11.5px] font-medium text-emerald-500">
				v{p.active_version}
			</span>
		{/if}

		<span class="text-[13px] text-zinc-400">{formatDate(p.updated_at)}</span>

		<div class="flex items-center justify-end gap-1.5">
			<button
				type="button"
				class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-semibold text-zinc-300 hover:bg-surface-4 disabled:opacity-50"
				disabled={busy}
				onclick={(event) => {
					event.stopPropagation();
					onpreview();
				}}
			>
				Preview
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-semibold text-zinc-300 hover:bg-surface-4 disabled:opacity-50"
				disabled={busy}
				onclick={(event) => {
					event.stopPropagation();
					onedit();
				}}
			>
				Edit
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-red-500/30 bg-red-500/8 px-2.5 text-[11.5px] font-semibold text-red-400 hover:bg-red-500/15 disabled:opacity-50"
				disabled={busy}
				onclick={(event) => {
					event.stopPropagation();
					confirmDeleteOpen = true;
				}}
			>
				Delete
			</button>
		</div>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={3} />

		<Panel title="Versions">
			{#snippet actions()}
				<button
					type="button"
					class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4 hover:text-zinc-200"
					onclick={onnewversion}
				>
					New version
				</button>
			{/snippet}

			{#if versions.loading && versions.rows.length === 0}
				<div class="px-3.5 py-[13px] text-[12.5px] text-zinc-600">Loading versions…</div>
			{:else if versions.error}
				<div class="flex items-center gap-3 px-3.5 py-[13px]">
					<span class="text-[12.5px] text-red-400">{versions.error}</span>
					<button
						type="button"
						class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4"
						onclick={() => store.loadVersions(p.id)}
					>
						Retry
					</button>
				</div>
			{:else if versions.rows.length === 0}
				<div class="px-3.5 py-[13px] text-[12.5px] leading-normal text-zinc-600">
					No versions yet — this prompt has no text to render. The first one you add becomes the active version.
				</div>
			{:else}
				<div class="flex flex-col">
					{#each versions.rows as row, index (row.id)}
						{@const isActive = p.active_version === row.version}
						<div class="flex items-center gap-3 px-3.5 py-2.5 {index > 0 ? 'border-t border-line' : ''}">
							<span class="w-10 flex-none font-mono text-[12.5px] font-medium text-zinc-200">v{row.version}</span>

							{#if isActive}
								<span class="flex-none rounded-[5px] bg-emerald-500/12 px-1.5 py-px text-[10.5px] font-medium text-emerald-500">
									active
								</span>
							{/if}

							<span class="text-[11.5px] text-zinc-600" title={fmtTs(row.created_at).full}>
								created {formatDate(row.created_at)}
							</span>

							<div class="ml-auto flex flex-none items-center gap-1.5">
								{#if !isActive}
									<button
										type="button"
										class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4 hover:text-zinc-200 disabled:opacity-50"
										disabled={busy}
										onclick={() => activate(row.version)}
									>
										Set active
									</button>
								{/if}
								<button
									type="button"
									class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4 hover:text-zinc-200 disabled:opacity-50"
									disabled={busy}
									onclick={() => oneditversion(row.version)}
								>
									Edit
								</button>
								<!-- The API refuses to delete the version a prompt is pointing
								     at, so the control is not offered for it. -->
								{#if !isActive}
									<button
										type="button"
										class="h-7 rounded-md border border-red-500/30 bg-red-500/8 px-2.5 text-[11.5px] font-medium text-red-400 hover:bg-red-500/15 disabled:opacity-50"
										disabled={busy}
										onclick={() => askDeleteVersion(row.version)}
									>
										Delete
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</Panel>
	{/snippet}
</ExpandableRow>

<ConfirmDialog
	bind:open={confirmDeleteOpen}
	title="Delete this prompt?"
	description="'{p.name}' and every version under it are deleted. Anything resolving this prompt by name stops working immediately. This cannot be undone."
	confirmLabel="Delete prompt"
	tone="danger"
	{busy}
	onconfirm={remove}
/>

<ConfirmDialog
	bind:open={confirmVersionOpen}
	title="Delete version {versionToDelete}?"
	description="The text of v{versionToDelete} is removed for good. The prompt and its other versions are left alone."
	confirmLabel="Delete version"
	tone="danger"
	{busy}
	onconfirm={removeVersion}
/>
