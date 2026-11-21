<script lang="ts">
import { toast } from 'svelte-sonner';
import { resolveActorNames } from '#lib/api/actors.ts';
import type { Prompt } from '#lib/api/types.ts';
import ConfirmDialog from '#lib/components/app/confirm-dialog.svelte';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import Panel from '#lib/components/app/panel.svelte';
import { fmtTs, formatDate, pairSummary, toneFor } from '#lib/data/format.ts';
import { prompts as store } from '#lib/state/prompts.svelte.ts';

interface Props {
  prompt: Prompt;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
  onedit: () => void;
  onpreview: () => void;
  onnewversion: () => void;
  oneditversion: (version: number) => void;
}

let { prompt, cols, expanded, ontoggle, onedit, onpreview, onnewversion, oneditversion }: Props = $props();

let creatorName: string | null = $state(null);
let busy = $state(false);
let confirmDeleteOpen = $state(false);

// The version waiting to be confirmed, and the dialog's own open flag. They are
// two pieces of state, because ConfirmDialog closes itself by writing to `open`
// and so needs something writable. The number is left set while the dialog
// animates out, or its title would flash a missing version on the way.
let confirmVersionOpen = $state(false);
let versionToDelete: number | null = $state(null);

const p = $derived(prompt);
const tone = $derived(toneFor(p.id));
const versions = $derived(store.versionsFor(p.id));
const created = $derived(fmtTs(p.created_at));
const updated = $derived(fmtTs(p.updated_at));

const detailItems: DetailItem[] = $derived([
  {
    label: 'Prompt ID',
    value: p.id,
    title: p.id,
    copyable: true,
    auditHref: `/audit?target_type=prompt&target_id=${encodeURIComponent(p.id)}`,
  },
  { label: 'Created', value: created.full, title: created.full, mono: false },
  { label: 'Created by', value: creatorName ?? p.creator_id ?? '—', title: p.creator_id ?? undefined, mono: false },
  { label: 'Last updated', value: updated.full, title: updated.full, mono: false },
]);

// The name behind the creator's id, looked up once the row is opened. When it
// cannot be resolved, the id stays on show.
$effect(() => {
  const creatorId = p.creator_id;

  creatorName = null;

  if (!expanded || !creatorId) {
    return;
  }

  const creator = { actor_type: 'user', actor_id: creatorId };
  let cancelled = false;

  resolveActorNames([creator])
    .then((name) => {
      if (!cancelled) {
        creatorName = name(creator).trim() || null;
      }
    })
    .catch(() => {});

  return () => {
    cancelled = true;
  };
});

// Fetched when the row opens and not with the page, which would otherwise make
// a request per prompt for panels nobody looked at.
$effect(() => {
  if (expanded) {
    void store.ensureVersions(p.id);
  }
});

// The row itself is a button, so its own buttons keep their clicks from
// toggling it.
function preview(event: MouseEvent): void {
  event.stopPropagation();
  onpreview();
}

function edit(event: MouseEvent): void {
  event.stopPropagation();
  onedit();
}

function askDelete(event: MouseEvent): void {
  event.stopPropagation();
  confirmDeleteOpen = true;
}

function askDeleteVersion(version: number): void {
  versionToDelete = version;
  confirmVersionOpen = true;
}

async function remove(): Promise<void> {
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

async function removeVersion(): Promise<void> {
  if (versionToDelete === null) {
    return;
  }

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

async function activate(version: number): Promise<void> {
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
			<!-- A dot in the prompt's own colour and not an initials block, which
			     would be the tallest thing in the row and set its height. -->
			<span class="size-[7px] flex-none rounded-full" style:background={tone}></span>
			<span class="overflow-hidden font-mono text-[13px] font-medium text-ellipsis whitespace-nowrap">{p.name}</span>
		</span>

		<!-- Beside the name and not under it, which would make every row two lines tall. -->
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-500">
			{p.description ?? '—'}
		</span>

		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-400" title={pairSummary(p.tags)}>
			{pairSummary(p.tags)}
		</span>

		<!-- A prompt with no active version cannot be resolved by a caller at all,
		     which is worth saying outright rather than leaving the cell blank. -->
		{#if p.active_version == null}
			<span class="rounded-[5px] bg-amber-500/12 px-1.5 py-px text-center text-[11.5px] font-medium text-amber-400">
				Unversioned
			</span>
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
				onclick={preview}
			>
				Preview
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-semibold text-zinc-300 hover:bg-surface-4 disabled:opacity-50"
				disabled={busy}
				onclick={edit}
			>
				Edit
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-red-500/30 bg-red-500/8 px-2.5 text-[11.5px] font-semibold text-red-400 hover:bg-red-500/15 disabled:opacity-50"
				disabled={busy}
				onclick={askDelete}
			>
				Delete
			</button>
		</div>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={4} />

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
