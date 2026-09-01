<script lang="ts">
import type { Webhook, WebhookDelivery } from '$lib/api/types';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import { fmtTs, timeAgo } from '$lib/data/format';
import { deliveryOutcome } from '$lib/data/webhooks';

let {
  delivery,
  webhook,
  cols,
  expanded,
  ontoggle,
}: {
  delivery: WebhookDelivery;
  /** Undefined when the endpoint is not in the loaded page - see OutboxRow. */
  webhook: Webhook | undefined;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
} = $props();

const attempted = $derived(fmtTs(delivery.created_at));
const outcome = $derived(deliveryOutcome(delivery.status_code));

const detailItems: DetailItem[] = $derived([
  { label: 'Delivery ID', value: delivery.id },
  { label: 'Outbox ID', value: delivery.outbox_id },
  { label: 'Webhook ID', value: delivery.webhook_id },
  { label: 'Endpoint', value: webhook?.endpoint ?? '—', title: webhook?.endpoint },
  { label: 'Attempted at', value: attempted.full },
  { label: 'Response', value: `${delivery.status_code} · ${outcome.label}`, tone: outcome.color, mono: false },
]);
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400">
			<span class="text-zinc-600">{attempted.short} · </span>{attempted.time}
		</span>

		<!-- Single line now. The relative time under the name only restated the
		     Attempted column beside it, and cost every row a second line to do it. -->
		<span class="min-w-0" title={timeAgo(delivery.created_at)}>
			{#if webhook}
				<span class="block overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-200">
					{webhook.name}
				</span>
			{:else}
				<code class="block overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-zinc-500">
					{delivery.webhook_id}
				</code>
			{/if}
		</span>

		<span class="text-right font-mono text-xs font-medium tabular-nums" style:color={outcome.color}>
			{delivery.status_code}
		</span>

		<span class="inline-flex items-center gap-1.5 text-xs font-medium" style:color={outcome.color}>
			<span class="size-1.5 flex-none rounded-full" style:background={outcome.color}></span>{outcome.label}
		</span>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={3} />
	{/snippet}
</ExpandableRow>
