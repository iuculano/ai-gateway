<script lang="ts">
import { onMount } from 'svelte';
import type { Webhook } from '#lib/api/types.ts';
import AutoRefreshToggle from '#lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import RefreshButton from '#lib/components/app/refresh-button.svelte';
import TableCard from '#lib/components/app/table-card.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import DeliveryRow from '#lib/components/webhooks/delivery-row.svelte';
import OutboxRow from '#lib/components/webhooks/outbox-row.svelte';
import WebhookDialog from '#lib/components/webhooks/webhook-dialog.svelte';
import WebhookRow from '#lib/components/webhooks/webhook-row.svelte';
import {
  buildActivity,
  deliveryOutcome,
  EMPTY_ACTIVITY,
  searchDeliveries,
  searchEndpoints,
  searchOutbox,
} from '#lib/data/webhooks.ts';
import { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';
import { webhooks } from '#lib/state/webhooks.svelte.ts';

type View = 'endpoints' | 'outbox';

// One grid per table, shared with that table's row component, so that the
// header and the rows sit in one grid.
const ENDPOINT_COLS = '24px minmax(130px,1.1fr) minmax(130px,1.2fr) minmax(170px,1.5fr) 90px 84px 104px 124px';
const OUTBOX_COLS = '24px 128px minmax(120px,1fr) 84px';
const DELIVERY_COLS = '24px 128px minmax(110px,1fr) 60px 104px';

// Deliveries are shown a screenful at a time. Theirs is the only list of the
// three that grows without end, with a row for every attempt, and showing
// every loaded row made the queue view taller than the window on its own.
const DELIVERY_PAGE_SIZE = 20;

const ENDPOINT_COLUMNS = [
  { label: '' },
  { label: 'Name' },
  { label: 'Description' },
  { label: 'Endpoint' },
  { label: 'Filter' },
  { label: 'Pending', align: 'right' as const },
  { label: 'Created' },
  { label: 'Actions', align: 'right' as const },
];

// The log id and the endpoint are left to each row's expanded panel, because
// these two tables share the width of one.
const OUTBOX_COLUMNS = [
  { label: '' },
  { label: 'Queued' },
  { label: 'Webhook' },
  { label: 'Waiting', align: 'right' as const },
];

const DELIVERY_COLUMNS = [
  { label: '' },
  { label: 'Attempted' },
  { label: 'Webhook' },
  { label: 'Status', align: 'right' as const },
  { label: 'Outcome' },
];

// Two tabs and not three. The queue and the attempts it produced are read
// together, because a row leaves the outbox and turns up in the deliveries
// moments later.
const VIEW_TABS = [
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'outbox', label: 'Queue' },
] satisfies { id: View; label: string }[];

const auto = new AutoRefresh();

let view: View = $state('endpoints');

// The open row, as one slot across all three tables. They can share it because
// every id in them is a UUID from a different table. One held over from
// another view matches nothing there, and its row is open again when its own
// view comes back.
let expandedRow: string | null = $state(null);

// Which screenful of deliveries is on show, counted from zero.
let deliveryPage = $state(0);

let dialogOpen = $state(false);

// The endpoint the dialog is editing, or null when it is creating one.
let editing: Webhook | null = $state(null);

// The lists on show. The queue view shows two at once, side by side.
const shown = $derived(view === 'endpoints' ? [webhooks.endpoints] : [webhooks.outbox, webhooks.deliveries]);

// A refresh reads first pages only, so tailing pauses once a list on show has
// been paged. On the queue view it also pauses while the deliveries are off
// their first screenful, which a refresh would shuffle out from under the
// reader.
const tailable = $derived(shown.every((list) => !list.appended) && (view === 'endpoints' || deliveryPage === 0));

/**
 * Reads the lists on show again. Both halves of the queue view are read in one
 * tick, so that a row leaving the outbox and the delivery it became arrive
 * together.
 */
async function refreshShown(): Promise<void> {
  await Promise.all(shown.map((list) => list.refresh()));
}

$effect(() => auto.schedule(tailable, refreshShown));

// Loaded once on mount and not in an effect, which would run again whenever
// the load changed its own state.
onMount(() => {
  void webhooks.ensureLoaded();
});

function openCreate(): void {
  editing = null;
  dialogOpen = true;
}

function openEdit(webhook: Webhook): void {
  editing = webhook;
  dialogOpen = true;
}

// Counted over the rows that are loaded, and not over all time.
const activity = $derived(buildActivity(webhooks.outbox.rows, webhooks.deliveries.rows));
const delivered = $derived(
  webhooks.deliveries.rows.filter((delivery) => deliveryOutcome(delivery.status_code).ok).length,
);
const failed = $derived(webhooks.deliveries.rows.length - delivered);
const successRate = $derived(
  webhooks.deliveries.rows.length === 0 ? null : (delivered / webhooks.deliveries.rows.length) * 100,
);

// The top bar's search box narrows all three tables.
const query = $derived(dashboard.search.trim().toLowerCase());
const filteredEndpoints = $derived(searchEndpoints(webhooks.endpoints.rows, query));
const filteredOutbox = $derived(searchOutbox(webhooks.outbox.rows, query, webhooks.byId));
const filteredDeliveries = $derived(searchDeliveries(webhooks.deliveries.rows, query, webhooks.byId));

const pagedDeliveries = $derived(
  filteredDeliveries.slice(deliveryPage * DELIVERY_PAGE_SIZE, (deliveryPage + 1) * DELIVERY_PAGE_SIZE),
);

// Whether the screenful on show reaches the end of what has been fetched.
const atEndOfLoadedDeliveries = $derived((deliveryPage + 1) * DELIVERY_PAGE_SIZE >= filteredDeliveries.length);
const canPageDeliveriesForward = $derived(!atEndOfLoadedDeliveries || webhooks.deliveries.hasMore);

// A list that shrinks must not leave the reader past its end. A search that
// narrows to three rows, or a refresh that brings back fewer, would otherwise
// show an empty table.
$effect(() => {
  const lastPage = Math.max(0, Math.ceil(filteredDeliveries.length / DELIVERY_PAGE_SIZE) - 1);

  if (deliveryPage > lastPage) {
    deliveryPage = lastPage;
  }
});

/**
 * Steps one screenful older, fetching the next page when this one runs out.
 * The list is fetched 50 at a time and shown 20 at a time, so most steps cost
 * nothing.
 */
async function nextDeliveryPage(): Promise<void> {
  if (webhooks.deliveries.loadingMore) {
    return;
  }

  if (atEndOfLoadedDeliveries) {
    if (!webhooks.deliveries.hasMore) {
      return;
    }

    await webhooks.deliveries.loadMore();

    // The fetch can fail, or bring back rows the search leaves out. Either way
    // there is nothing to step to, and stepping would blank the table.
    if (atEndOfLoadedDeliveries) {
      return;
    }
  }

  expandedRow = null;
  deliveryPage += 1;
}

function previousDeliveryPage(): void {
  if (deliveryPage === 0) {
    return;
  }

  expandedRow = null;
  deliveryPage -= 1;
}

/**
 * Reads every list again from the top, which puts the deliveries back on their
 * first screenful.
 */
function refreshAll(): void {
  deliveryPage = 0;
  expandedRow = null;
  void webhooks.refresh();
}
</script>

<PageHeader
	title="Webhooks"
	description="Push every log Relay records to your own services, filtered by tag."
>
	{#snippet actions()}
		<ToolbarButton variant="primary" onclick={openCreate}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 3.3v9.4M3.3 8h9.4" stroke="#04130d" stroke-width="1.8" stroke-linecap="round" /></svg>
			Create webhook
		</ToolbarButton>
	{/snippet}
</PageHeader>

{#snippet statsSummary()}
	<span class="flex flex-wrap items-baseline gap-x-1 whitespace-nowrap text-[12.5px] text-zinc-500">
		<span class="font-medium text-zinc-100 tabular-nums">{filteredEndpoints.length.toLocaleString()}</span>
		of <span class="font-medium text-zinc-200 tabular-nums">{webhooks.endpoints.rows.length.toLocaleString()}</span> endpoints
		<span class="mx-1 text-zinc-600">·</span>
		<!-- Queue and delivery counts cover loaded rows, not all-time totals. -->
		<span
			class="font-medium text-emerald-400 tabular-nums"
			title={successRate === null ? undefined : `${successRate.toFixed(1)}% of delivery attempts succeeded`}
		>{delivered.toLocaleString()}</span> delivered
		<span class="mx-1 text-zinc-600">·</span>
		<span class="font-medium text-amber-400 tabular-nums">{webhooks.outbox.rows.length.toLocaleString()}</span> pending
		<span class="mx-1 text-zinc-600">·</span>
		<span class="font-medium text-red-400 tabular-nums">{failed.toLocaleString()}</span> failed
	</span>
{/snippet}

{#snippet viewTabs()}
	<FilterTabs tabs={VIEW_TABS} bind:value={view} />
{/snippet}

{#snippet refreshControls()}
	<AutoRefreshToggle {auto} active={tailable} pausedLabel="paused past page 1" />

	<RefreshButton disabled={shown.some((entry) => entry.loading)} onclick={refreshAll} />
{/snippet}

{#if view === 'endpoints'}
	<TableCard
		cols={ENDPOINT_COLS}
		columns={ENDPOINT_COLUMNS}
		loading={webhooks.endpoints.loading && webhooks.endpoints.rows.length === 0}
		error={webhooks.endpoints.error}
		isEmpty={filteredEndpoints.length === 0}
		loadingLabel="Loading webhooks…"
		emptyTitle={webhooks.endpoints.rows.length === 0 ? 'No webhooks yet' : 'No webhooks match your search'}
		emptyHint={webhooks.endpoints.rows.length === 0
			? 'Create an endpoint to start receiving events as they are logged.'
			: undefined}
		onretry={() => webhooks.endpoints.load()}
		showFooter={webhooks.endpoints.hasMore}
	>
		{#snippet toolbar()}
			{@render viewTabs()}
			{@render statsSummary()}

			<span class="ml-auto"></span>
			{@render refreshControls()}
		{/snippet}

		{#each filteredEndpoints as webhook (webhook.id)}
			<WebhookRow
				{webhook}
				cols={ENDPOINT_COLS}
				activity={activity.get(webhook.id) ?? EMPTY_ACTIVITY}
				expanded={expandedRow === webhook.id}
				ontoggle={() => (expandedRow = expandedRow === webhook.id ? null : webhook.id)}
				onedit={() => openEdit(webhook)}
			/>
		{/each}

		{#snippet footer()}
			<ToolbarButton disabled={webhooks.endpoints.loadingMore} onclick={() => webhooks.endpoints.loadMore()}>
				{webhooks.endpoints.loadingMore ? 'Loading…' : 'Load older webhooks'}
			</ToolbarButton>
		{/snippet}
	</TableCard>
{:else}
	<!-- Side by side from xl up, and stacked below it. Each table wants about
	     450px of columns, and two of them at a laptop's width would cut off the
	     webhook names that both are read by. -->
	<div class="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-2">
		<TableCard
			cols={OUTBOX_COLS}
			columns={OUTBOX_COLUMNS}
			loading={webhooks.outbox.loading && webhooks.outbox.rows.length === 0}
			error={webhooks.outbox.error}
			isEmpty={filteredOutbox.length === 0}
			loadingLabel="Loading the outbox…"
			emptyTitle={webhooks.outbox.rows.length === 0 ? 'Nothing queued' : 'Nothing queued matches your search'}
			emptyHint={webhooks.outbox.rows.length === 0
				? 'Rows appear here the moment a log matches a webhook, and leave once the worker has attempted them.'
				: undefined}
			onretry={() => webhooks.outbox.load()}
			showFooter={webhooks.outbox.hasMore}
		>
			{#snippet toolbar()}
				{@render viewTabs()}
				{@render statsSummary()}
				<span class="ml-auto"></span>
				{@render refreshControls()}
			{/snippet}

			{#each filteredOutbox as entry (entry.id)}
				<OutboxRow
					{entry}
					webhook={webhooks.byId.get(entry.webhook_id)}
					cols={OUTBOX_COLS}
					expanded={expandedRow === entry.id}
					ontoggle={() => (expandedRow = expandedRow === entry.id ? null : entry.id)}
				/>
			{/each}

			{#snippet footer()}
				<ToolbarButton disabled={webhooks.outbox.loadingMore} onclick={() => webhooks.outbox.loadMore()}>
					{webhooks.outbox.loadingMore ? 'Loading…' : 'Load older queued rows'}
				</ToolbarButton>
			{/snippet}
		</TableCard>

		<TableCard
			cols={DELIVERY_COLS}
			columns={DELIVERY_COLUMNS}
			loading={webhooks.deliveries.loading && webhooks.deliveries.rows.length === 0}
			error={webhooks.deliveries.error}
			isEmpty={filteredDeliveries.length === 0}
			loadingLabel="Loading deliveries…"
			emptyTitle={webhooks.deliveries.rows.length === 0 ? 'No delivery attempts yet' : 'No attempts match your search'}
			emptyHint={webhooks.deliveries.rows.length === 0
				? 'One row is recorded per attempt, whether or not the endpoint accepted it.'
				: undefined}
			onretry={() => webhooks.deliveries.load()}
			showFooter={deliveryPage > 0 || canPageDeliveriesForward}
		>
			{#snippet toolbar()}
				<!-- h-8 matches FilterTabs' outer height, which the left card's toolbar
				     carries. Without it this toolbar is shorter and the two tables'
				     column headers sit at different heights, which is very visible when
				     they are side by side. -->
				<span class="flex h-8 items-center text-[12.5px] font-medium text-zinc-300">Deliveries</span>
				<span class="text-[12.5px] text-zinc-600">
					{pagedDeliveries.length} of {filteredDeliveries.length}{webhooks.deliveries.hasMore ? ' loaded' : ''}
				</span>

				<span class="ml-auto flex items-center gap-[7px] text-[12.5px] text-zinc-600">
					<span class="size-[5px] rounded-full bg-zinc-700"></span>
					One row per attempt · not retried
				</span>
			{/snippet}

			{#each pagedDeliveries as delivery (delivery.id)}
				<DeliveryRow
					{delivery}
					webhook={webhooks.byId.get(delivery.webhook_id)}
					cols={DELIVERY_COLS}
					expanded={expandedRow === delivery.id}
					ontoggle={() => (expandedRow = expandedRow === delivery.id ? null : delivery.id)}
				/>
			{/each}

			{#snippet footer()}
				<div class="flex items-center justify-center gap-3">
					<ToolbarButton disabled={deliveryPage === 0 || webhooks.deliveries.loadingMore} onclick={previousDeliveryPage}>
						<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 4L6 8l3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
						Newer
					</ToolbarButton>

					<!-- 'Page N', not 'Page N of M'. The endpoint is cursor-paged with no
					     count behind it, so a total would have to be invented. -->
					<span class="min-w-[64px] text-center text-[12.5px] text-zinc-500">Page {deliveryPage + 1}</span>

					<ToolbarButton
						disabled={!canPageDeliveriesForward || webhooks.deliveries.loadingMore}
						onclick={nextDeliveryPage}
					>
						{webhooks.deliveries.loadingMore ? 'Loading…' : 'Older'}
						<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 4L10 8l-3.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
					</ToolbarButton>
				</div>
			{/snippet}
		</TableCard>
	</div>
{/if}

<WebhookDialog bind:open={dialogOpen} webhook={editing} />
