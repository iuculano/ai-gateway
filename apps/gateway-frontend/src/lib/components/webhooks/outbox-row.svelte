<script lang="ts">
import type { Webhook, WebhookOutboxEntry } from '$lib/api/types';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import { fmtTs, timeSince } from '$lib/data/format';

let {
  entry,
  webhook,
  cols,
  expanded,
  ontoggle,
}: {
  entry: WebhookOutboxEntry;
  /**
   * The endpoint this row is queued for, when it is in the loaded page of
   * webhooks. The outbox endpoint returns ids only, and the webhook list is
   * paginated separately, so a miss here is normal rather than an error.
   */
  webhook: Webhook | undefined;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
} = $props();

const queued = $derived(fmtTs(entry.created_at));

const detailItems: DetailItem[] = $derived([
  { label: 'Outbox ID', value: entry.id },
  { label: 'Webhook ID', value: entry.webhook_id },
  { label: 'Log ID', value: entry.log_id },
  { label: 'Endpoint', value: webhook?.endpoint ?? '—', title: webhook?.endpoint },
  { label: 'Queued at', value: queued.full },
  { label: 'Waiting', value: timeSince(entry.created_at), mono: false },
]);
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400">
			<span class="text-zinc-600">{queued.short} · </span>{queued.time}
		</span>

		<span class="flex min-w-0 items-center gap-2">
			<!-- Amber, not emerald: every row in this table is work the worker has
			     not done yet. -->
			<span class="size-1.5 flex-none rounded-full bg-amber-400"></span>
			{#if webhook}
				<span class="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-zinc-200">{webhook.name}</span>
			{:else}
				<code class="overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-zinc-500">
					{entry.webhook_id}
				</code>
			{/if}
		</span>

		<!-- A length, not a moment: this column answers how long the row has been
		     sat in the queue, which is the signal that the worker is behind. -->
		<span class="text-right text-[12.5px] text-zinc-400 tabular-nums" title={queued.full}>
			{timeSince(entry.created_at)}
		</span>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={3} />
	{/snippet}
</ExpandableRow>
