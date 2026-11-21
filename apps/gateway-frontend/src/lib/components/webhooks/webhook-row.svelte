<script lang="ts">
import { toast } from 'svelte-sonner';
import { resolveActorNames } from '#lib/api/actors.ts';
import type { Webhook } from '#lib/api/types.ts';
import ConfirmDialog from '#lib/components/app/confirm-dialog.svelte';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import Panel from '#lib/components/app/panel.svelte';
import { fmtTs, formatDate, pairSummary, timeAgo, toneFor } from '#lib/data/format.ts';
import type { WebhookActivity } from '#lib/data/webhooks.ts';
import { webhooks as store } from '#lib/state/webhooks.svelte.ts';

interface Props {
  webhook: Webhook;
  cols: string;

  /**
   * Counts over the outbox entries and deliveries that are loaded, and not
   * over the endpoint's whole history.
   */
  activity: WebhookActivity;
  expanded: boolean;
  ontoggle: () => void;
  onedit: () => void;
}

let { webhook, cols, activity, expanded, ontoggle, onedit }: Props = $props();

let creatorName: string | null = $state(null);
let busy = $state(false);
let confirmDeleteOpen = $state(false);

const w = $derived(webhook);
const tone = $derived(toneFor(w.id));
const filterRules = $derived(Object.entries(w.filter ?? {}));
const created = $derived(fmtTs(w.created_at));
const updated = $derived(fmtTs(w.updated_at));

const detailItems: DetailItem[] = $derived([
  {
    label: 'Webhook ID',
    value: w.id,
    title: w.id,
    copyable: true,
    auditHref: `/audit?target_type=webhook&target_id=${encodeURIComponent(w.id)}`,
  },
  { label: 'Created', value: created.full },
  { label: 'Created by', value: creatorName ?? w.creator_id ?? '—', title: w.creator_id ?? undefined, mono: false },
  { label: 'Last updated', value: updated.full },
  { label: 'Tags', value: pairSummary(w.tags), title: pairSummary(w.tags) },
  { label: 'Last attempt', value: timeAgo(activity.lastAttemptAt), mono: false },
]);

// The name behind the creator's id, looked up once the row is opened. When it
// cannot be resolved, the id stays on show.
$effect(() => {
  const creatorId = w.creator_id;

  creatorName = null;

  if (!expanded || !creatorId) {
    return;
  }

  const creator = { actor_type: 'user', actor_id: creatorId };
  let cancelled = false;

  resolveActorNames([creator])
    .then((name) => {
      if (!cancelled) {
        creatorName = name(creator);
      }
    })
    .catch(() => {});

  return () => {
    cancelled = true;
  };
});

// The row itself is a button, so its own buttons keep their clicks from
// toggling it.
function edit(event: MouseEvent): void {
  event.stopPropagation();
  onedit();
}

function askDelete(event: MouseEvent): void {
  event.stopPropagation();
  confirmDeleteOpen = true;
}

async function remove(): Promise<void> {
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
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<!-- A dot in the webhook's own colour and not an initials block, which
			     would be the tallest thing in the row and set its height. -->
			<span class="size-[7px] flex-none rounded-full" style:background={tone}></span>
			<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{w.name}</span>
		</span>

		<!-- Beside the name and not under it, which would make every row two lines tall. -->
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-500">
			{w.description ?? '—'}
		</span>

		<code class="overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-zinc-400" title={w.endpoint}>
			{w.endpoint}
		</code>

		<!-- An endpoint with no rules receives every log, which is worth saying
		     outright, because a blank cell reads as missing configuration. -->
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
		<DetailGrid items={detailItems} cols={6} />

		<div class="grid grid-cols-2 gap-3.5">
			<Panel title="Delivery filter">
				{#if filterRules.length === 0}
					<div class="flex grow items-center px-3.5 py-[13px] text-[12.5px] text-zinc-600">
						No rules — every log recorded in this organization is queued for this endpoint.
					</div>
				{:else}
					<!-- One grid for the whole list and not a flex row per pair. The three
					     columns are shared, so the equals signs and the values line up down
					     the panel however long the keys are.

					     The separators are borders on each cell, because a flat grid has no
					     row element to hang a hairline on. -->
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

			<!-- Counted over the rows that are paged in, and captioned as such.
			     Neither list endpoint returns a total, so a bare figure here would
			     read as the endpoint's whole history. -->
			<Panel title="Activity">
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
