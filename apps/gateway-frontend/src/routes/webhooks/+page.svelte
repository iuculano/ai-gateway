<script lang="ts">
import { onMount } from 'svelte';
import type { Webhook } from '$lib/api/types';
import AutoRefreshToggle from '$lib/components/app/auto-refresh-toggle.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import TableCard from '$lib/components/app/table-card.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import DeliveryRow from '$lib/components/webhooks/delivery-row.svelte';
import OutboxRow from '$lib/components/webhooks/outbox-row.svelte';
import WebhookDialog from '$lib/components/webhooks/webhook-dialog.svelte';
import WebhookRow from '$lib/components/webhooks/webhook-row.svelte';
import { pairSummary } from '$lib/data/format';
import { buildActivity, deliveryOutcome, EMPTY_ACTIVITY } from '$lib/data/webhooks';
import { AutoRefresh } from '$lib/state/auto-refresh.svelte';
import { dashboard } from '$lib/state/dashboard.svelte';
import { webhooks } from '$lib/state/webhooks.svelte';

type View = 'endpoints' | 'outbox';

// One grid per view, shared with that view's row component so the header and
// the rows sit in one grid - the same contract the other three tables use.
const ENDPOINT_COLS = '24px minmax(130px,1.1fr) minmax(130px,1.2fr) minmax(170px,1.5fr) 90px 84px 104px 124px';
const OUTBOX_COLS = '24px 128px minmax(120px,1fr) 84px';
const DELIVERY_COLS = '24px 128px minmax(110px,1fr) 60px 104px';

// Deliveries are windowed to one screenful. The list is the only one of the
// three that grows without bound - one row per attempt, forever - and rendering
// every loaded row made the queue view taller than the viewport on its own.
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

// Log ID and Endpoint were dropped when these moved to half width. Both are
// still in each row's expanded panel, so nothing became unreachable.
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

let view: View = $state('endpoints');

/**
 * The open row, as one slot across all three tables.
 *
 * They can share it because every id in them is a uuid from a different table:
 * one held over from another view matches nothing, so the row renders closed -
 * and comes back open when that view does.
 */
let expandedRow: string | null = $state(null);

/** Which window of deliveries is on screen. Zero-based, like the logs page. */
let deliveryPage = $state(0);

let dialogOpen = $state(false);

/** The row the dialog is editing; null puts it in create mode. */
let editing: Webhook | null = $state(null);

// Load once on mount - NOT $effect, which would re-run whenever a load mutates
// its own loading flag and hammer the endpoints on any error.
const auto = new AutoRefresh();

// Only the list actually on screen is tailed. Refreshing all three on every
// tick would be three requests to redraw two tables nobody is looking at - and
// the outbox is the one worth watching live, since it drains on its own.
// Tails whatever is on screen - both halves of the queue view, so the outbox
// draining and the delivery it produced arrive in the same tick rather than a
// refresh apart.
$effect(() =>
  auto.schedule(tailable, async () => {
    await Promise.all(shown.map((entry) => entry.refresh()));
  }),
);

onMount(() => {
  webhooks.ensureLoaded();
});

function openCreate() {
  editing = null;
  dialogOpen = true;
}

function openEdit(webhook: Webhook) {
  editing = webhook;
  dialogOpen = true;
}

/** Per-endpoint counters, over the loaded outbox and delivery windows. */
const activity = $derived(buildActivity(webhooks.outbox.rows, webhooks.deliveries.rows));

const delivered = $derived(webhooks.deliveries.rows.filter((d) => deliveryOutcome(d.status_code).ok).length);
const failed = $derived(webhooks.deliveries.rows.length - delivered);
const successRate = $derived(
  webhooks.deliveries.rows.length === 0 ? null : (delivered / webhooks.deliveries.rows.length) * 100,
);

// The topbar's search box, shared by every page.
const query = $derived(dashboard.search.trim().toLowerCase());

const filteredEndpoints = $derived(
  webhooks.endpoints.rows.filter(
    (w) =>
      !query ||
      `${w.name} ${w.description ?? ''} ${w.endpoint} ${pairSummary(w.tags)} ${pairSummary(w.filter)}`
        .toLowerCase()
        .includes(query),
  ),
);

// The outbox and delivery tables carry ids, so their search also has to cover
// the endpoint name those ids resolve to - matching on the raw uuid alone would
// make the box useless on two of the three views.
const filteredOutbox = $derived(
  webhooks.outbox.rows.filter(
    (entry) =>
      !query ||
      `${entry.log_id} ${entry.webhook_id} ${webhooks.byId.get(entry.webhook_id)?.name ?? ''}`
        .toLowerCase()
        .includes(query),
  ),
);

const filteredDeliveries = $derived(
  webhooks.deliveries.rows.filter((delivery) => {
    if (!query) return true;

    const webhook = webhooks.byId.get(delivery.webhook_id);
    const outcome = deliveryOutcome(delivery.status_code);

    return `${delivery.status_code} ${outcome.label} ${delivery.webhook_id} ${webhook?.name ?? ''} ${webhook?.endpoint ?? ''}`
      .toLowerCase()
      .includes(query);
  }),
);

/** The 20 attempts on screen. */
const pagedDeliveries = $derived(
  filteredDeliveries.slice(deliveryPage * DELIVERY_PAGE_SIZE, (deliveryPage + 1) * DELIVERY_PAGE_SIZE),
);

/** Whether this window reaches the end of what has been fetched so far. */
const atEndOfLoadedDeliveries = $derived((deliveryPage + 1) * DELIVERY_PAGE_SIZE >= filteredDeliveries.length);

const canPageDeliveriesForward = $derived(!atEndOfLoadedDeliveries || webhooks.deliveries.hasMore);

// A shrinking list must not strand the window past the end of it - a search that
// narrows to three rows, or a refresh that returns fewer, would otherwise leave
// an empty table with no way back except paging.
$effect(() => {
  const lastPage = Math.max(0, Math.ceil(filteredDeliveries.length / DELIVERY_PAGE_SIZE) - 1);

  if (deliveryPage > lastPage) {
    deliveryPage = lastPage;
  }
});

/**
 * Steps one window older, fetching the next server page when this one runs out.
 *
 * The list is fetched 50 at a time and shown 20 at a time, so most steps are a
 * slice of rows already in hand and cost nothing.
 */
async function nextDeliveryPage() {
  if (webhooks.deliveries.loadingMore) return;

  if (atEndOfLoadedDeliveries) {
    if (!webhooks.deliveries.hasMore) return;

    await webhooks.deliveries.loadMore();

    // The fetch can fail, or return rows the current search excludes. Either
    // way there is no window to move to, and advancing would blank the table.
    if ((deliveryPage + 1) * DELIVERY_PAGE_SIZE >= filteredDeliveries.length) return;
  }

  expandedRow = null;
  deliveryPage += 1;
}

function previousDeliveryPage() {
  if (deliveryPage === 0) return;

  expandedRow = null;
  deliveryPage -= 1;
}

/** Re-reads every list from the top, which puts the delivery window back on it. */
function refreshAll() {
  deliveryPage = 0;
  expandedRow = null;
  webhooks.refresh();
}

// Two tabs, not three. The queue and the attempts it produced are one subject
// read together - a row leaves the outbox and appears in deliveries moments
// later, and watching that as two separate tables meant flipping back and forth
// to follow a single delivery.
const VIEW_TABS = $derived([
  { id: 'endpoints' as const, label: `Endpoints · ${webhooks.endpoints.rows.length}` },
  { id: 'outbox' as const, label: `Queue · ${webhooks.outbox.rows.length}` },
]);

/** The lists on screen. The queue view shows two at once, side by side. */
const shown = $derived(view === 'endpoints' ? [webhooks.endpoints] : [webhooks.outbox, webhooks.deliveries]);

/**
 * Tailing re-reads first pages only, so it pauses if any shown list was paged -
 * and, on the queue view, while the delivery window is off its first page, which
 * a re-read would shuffle out from under.
 */
const tailable = $derived(shown.every((list) => !list.appended) && (view === 'endpoints' || deliveryPage === 0));
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

<StatGrid>
	<StatCard
		label="Endpoints"
		value={webhooks.endpoints.rows.length}
		hint={webhooks.endpoints.hasMore ? 'first page' : undefined}
	/>
	<!-- '· loaded' on the three that are counted client-side over the rows paged
	     in: neither the outbox nor the deliveries endpoint returns an aggregate,
	     and an uncaptioned figure here would read as an all-time total. -->
	<StatCard label="Pending · loaded" value={webhooks.outbox.rows.length} accent="#f59e0b" />
	<StatCard
		label="Delivered · loaded"
		value={delivered}
		accent="#10b981"
		hint={successRate === null ? undefined : `${successRate.toFixed(1)}%`}
	/>
	<StatCard label="Failed · loaded" value={failed} accent="#f87171" />
</StatGrid>

{#snippet viewTabs()}
	<FilterTabs tabs={VIEW_TABS} bind:value={view} />
{/snippet}

{#snippet refreshControls()}
	<AutoRefreshToggle {auto} active={tailable} pausedLabel="paused past page 1" />

	<ToolbarButton disabled={shown.some((entry) => entry.loading)} onclick={refreshAll}>
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
		Refresh
	</ToolbarButton>
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
			<span class="text-[12.5px] text-zinc-600">
				{filteredEndpoints.length} of {webhooks.endpoints.rows.length} webhooks{webhooks.endpoints.hasMore ? ' loaded' : ''}
			</span>

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
	<!-- The queue and the attempts it produced, read together: a row leaves the
	     outbox and appears on the right moments later, which as two tabs meant
	     flipping back and forth to follow one delivery.

	     Stacked below xl. Each table still wants ~450px of columns, and two of
	     them at a laptop width would truncate the webhook names both key on. -->
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
