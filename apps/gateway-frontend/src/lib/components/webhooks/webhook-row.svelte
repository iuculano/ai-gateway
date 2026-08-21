<script lang="ts">
import { toast } from 'svelte-sonner';
import type { Webhook } from '$lib/api/types';
import ConfirmDialog from '$lib/components/app/confirm-dialog.svelte';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import { fmtTs, formatDate, initialsOf, pairSummary, timeAgo } from '$lib/data/format';
import type { WebhookActivity } from '$lib/data/webhooks';
import { webhooks as store } from '$lib/state/webhooks.svelte';

let {
  webhook,
  cols,
  activity,
  expanded,
  ontoggle,
  onedit,
}: {
  webhook: Webhook;
  cols: string;
  /** Counters over the loaded outbox and delivery windows - see buildActivity. */
  activity: WebhookActivity;
  expanded: boolean;
  ontoggle: () => void;
  onedit: () => void;
} = $props();

const TONES = ['#10b981', '#60a5fa', '#c084fc', '#f59e0b', '#34d399'];

const w = $derived(webhook);

// Same deterministic tone as the keys table, so an endpoint keeps its colour
// across renders and sorts.
const tone = $derived(TONES[[...w.id].reduce((acc, char) => acc + char.charCodeAt(0), 0) % TONES.length]);

const filterRules = $derived(Object.entries(w.filter ?? {}));
const created = $derived(fmtTs(w.created_at));
const updated = $derived(fmtTs(w.updated_at));

const detailItems: DetailItem[] = $derived([
  { label: 'Webhook ID', value: w.id },
  { label: 'Created', value: created.full },
  { label: 'Last updated', value: updated.full },
  { label: 'Description', value: w.description ?? '—', mono: false },
  { label: 'Tags', value: pairSummary(w.tags), title: pairSummary(w.tags) },
  { label: 'Last attempt', value: timeAgo(activity.lastAttemptAt), mono: false },
]);

let busy = $state(false);
let confirmDeleteOpen = $state(false);

async function remove() {
  busy = true;

  try {
    await store.remove(w.id);
    toast.success('Webhook deleted');
    confirmDeleteOpen = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to delete the webhook.');
  } finally {
    busy = false;
  }
}

function copyEndpoint(event: MouseEvent) {
  event.stopPropagation();
  navigator.clipboard?.writeText(w.endpoint).catch(() => {});
  toast.success('Endpoint copied');
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<!-- A tone dot rather than an initials block. The 32px avatar was the
			     tallest thing in the row and set the row height on its own; this keeps
			     the same deterministic colour at the height logs' rows run at. -->
			<span class="size-[7px] flex-none rounded-full" style:background={tone}></span>
			<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{w.name}</span>
		</span>

		<!-- Lifted out from under the name, where it made every row two lines tall. -->
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-500">
			{w.description ?? '—'}
		</span>

		<code class="overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-zinc-400" title={w.endpoint}>
			{w.endpoint}
		</code>

		<!-- An endpoint with no rules receives every log, which is worth saying
		     outright - a blank cell reads as missing configuration. -->
		{#if filterRules.length === 0}
			<span class="text-[12.5px] text-zinc-600">All events</span>
		{:else}
			<span class="text-[12.5px] text-zinc-300">
				{filterRules.length} rule{filterRules.length === 1 ? '' : 's'}
			</span>
		{/if}

		<span
			class="text-right text-[13px] tabular-nums {activity.pending > 0 ? 'text-amber-400' : 'text-zinc-600'}"
			title="Queued rows in the loaded window"
		>
			{activity.pending}
		</span>

		<span class="text-[13px] text-zinc-400">{formatDate(w.created_at)}</span>

		<div class="flex items-center justify-end gap-1.5">
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
		<!-- The endpoint gets a box of its own rather than a cell in the grid: it is
		     the one field here worth copying, and a grid cell has nowhere to hang the
		     button. Long URLs scroll sideways instead of wrapping the panel open. -->
		<Panel title="Endpoint">
			{#snippet actions()}
				<button
					type="button"
					class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4 hover:text-zinc-200"
					onclick={copyEndpoint}
				>
					Copy
				</button>
			{/snippet}
			<code class="block overflow-x-auto px-3.5 py-[13px] font-mono text-xs whitespace-nowrap text-zinc-200 select-all">
				{w.endpoint}
			</code>
		</Panel>

		<DetailGrid items={detailItems} cols={3} />

		<div class="grid grid-cols-2 gap-3.5">
			<Panel title="Delivery filter">
				{#if filterRules.length === 0}
					<div class="flex grow items-center px-3.5 py-[13px] text-[12.5px] text-zinc-600">
						No rules — every log recorded in this organization is queued for this endpoint.
					</div>
				{:else}
					<!-- One grid for the whole list rather than a flex row per pair. The
					     three columns are shared, so the `=` signs and the values line up
					     down the panel however long the individual keys are - as separate
					     flex rows each pair started wherever its own key ended.

					     The separators are per-cell borders because a flat grid has no row
					     element left to hang the old gap-px hairline on. -->
					<div class="grid grid-cols-[max-content_max-content_1fr] bg-surface-2">
						{#each filterRules as [key, value], index (key)}
							{@const divider = index > 0 ? 'border-t border-line' : ''}
							<code class="py-2.5 pr-2 pl-[13px] font-mono text-xs text-zinc-500 {divider}">log.tags.{key}</code>
							<span class="py-2.5 text-xs text-zinc-600 {divider}">=</span>
							<code class="min-w-0 py-2.5 pr-[13px] pl-2 font-mono text-xs break-words text-zinc-200 {divider}">{value}</code>
						{/each}
					</div>
					<div class="border-t border-line px-3.5 py-2.5 text-[11.5px] text-zinc-600">
						A log is delivered only when its tags carry every pair above.
					</div>
				{/if}
			</Panel>

			<!-- Counted over the rows currently paged in, and captioned as such:
			     neither list endpoint returns a total, so a bare figure here would
			     read as the endpoint's lifetime history. -->
			<Panel title="Activity · loaded window">
				<div class="flex grow items-center gap-8 px-3.5 py-[13px]">
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Pending</div>
						<div class="text-[13px] font-medium tabular-nums {activity.pending > 0 ? 'text-amber-400' : 'text-zinc-200'}">
							{activity.pending}
						</div>
					</div>
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Delivered</div>
						<div class="text-[13px] font-medium text-zinc-200 tabular-nums">{activity.delivered}</div>
					</div>
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Failed</div>
						<div class="text-[13px] font-medium tabular-nums {activity.failed > 0 ? 'text-red-400' : 'text-zinc-200'}">
							{activity.failed}
						</div>
					</div>
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Last attempt</div>
						<div class="text-[13px] font-medium text-zinc-200" title={activity.lastAttemptAt ?? undefined}>
							{timeAgo(activity.lastAttemptAt)}
						</div>
					</div>
				</div>
			</Panel>
		</div>

	{/snippet}
</ExpandableRow>

<ConfirmDialog
	bind:open={confirmDeleteOpen}
	title="Delete this webhook?"
	description="'{w.name}' stops receiving events immediately. Everything queued for it and its whole delivery history are deleted with it. This cannot be undone."
	confirmLabel="Delete webhook"
	tone="danger"
	{busy}
	onconfirm={remove}
/>
