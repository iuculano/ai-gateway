<script lang="ts">
import { fetchSeries, type SeriesPoint } from '#lib/api/analytics.ts';
import { listApiKeys } from '#lib/api/api-keys.ts';
import { listAllProviders } from '#lib/api/models.ts';
import { getAnalyticsFilters, windowBefore, windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import FilterPicker from '#lib/components/analytics/filter-picker.svelte';
import ChartCard from '#lib/components/app/chart-card.svelte';
import StatCard from '#lib/components/app/stat-card.svelte';
import StatGrid from '#lib/components/app/stat-grid.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { fmt, fmtCost, fmtSpend, providerTone } from '#lib/data/format.ts';
import {
  cacheSaved,
  cheapestSwitch,
  costAt,
  idleKeys,
  type KeySummary,
  type ModelPrice,
  rankKeys,
  usageByModel,
} from '#lib/data/savings.ts';
import { Latest } from '#lib/state/latest.svelte.ts';

interface Savings {
  points: SeriesPoint[];
  windowStart: Date;
  previousPoints: SeriesPoint[];

  /**
   * Without the window before, a key's change is unknown and not new.
   */
  previousFailed: boolean;
  prices: ModelPrice[];
  keys: KeySummary[];
  keysFailed: boolean;
}

const MAX_ROWS = 8;
const KEYS_PAGE_SIZE = 250;

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const filters = getAnalyticsFilters();
const savings = new Latest<Savings>();

// Left blank, each model is compared with the cheapest one already in use.
let target = $state('');

/**
 * Every API key, page by page, for their names and the idle check.
 */
async function listAllKeys(): Promise<KeySummary[]> {
  let page = await listApiKeys('all', { limit: KEYS_PAGE_SIZE });
  const keys: KeySummary[] = [...page.data];

  while (page.meta.more_data && page.meta.oldest_id) {
    page = await listApiKeys('all', { limit: KEYS_PAGE_SIZE, after_id: page.meta.oldest_id });
    keys.push(...page.data);
  }

  return keys;
}

async function fetchSavings(): Promise<Savings> {
  const range = windowOf(filters.range.days);

  const [[series], [previous, catalog, allKeys]] = await Promise.all([
    fetchSeries({ ...range, groupings: [['actor', 'provider', 'model']] }),

    // Settled on their own, so that none of these hides the spend by failing.
    Promise.allSettled([
      fetchSeries({ ...windowBefore(filters.range.days), groupings: [['actor']] }),
      listAllProviders(),
      listAllKeys(),
    ]),
  ]);

  return {
    points: series ?? [],
    windowStart: new Date(range.start_date),
    previousPoints: previous.status === 'fulfilled' ? (previous.value[0] ?? []) : [],
    previousFailed: previous.status === 'rejected',
    prices: catalog.status === 'fulfilled' ? catalog.value.data.flatMap((provider) => provider.models) : [],
    keys: allKeys.status === 'fulfilled' ? allKeys.value : [],
    keysFailed: allKeys.status === 'rejected',
  };
}

function load(): void {
  void savings.load(fetchSavings);
}

$effect(() => {
  void filters.range.id;
  load();
});

const loading = $derived(savings.loading);
const failed = $derived(savings.error !== null);
const points = $derived(savings.value?.points ?? []);
const previousPoints = $derived(savings.value?.previousPoints ?? []);
const prices = $derived(savings.value?.prices ?? []);
const keys = $derived(savings.value?.keys ?? []);
const keysFailed = $derived(savings.value?.keysFailed ?? false);
const windowStart = $derived(savings.value?.windowStart ?? new Date());

const usage = $derived(usageByModel(points));
const totalSpend = $derived(usage.reduce((sum, row) => sum + row.cost, 0));

// Chat models only, because an embedding model has no cheaper chat model to
// stand in for it.
const chatPrices = $derived(prices.filter((price) => price.type === 'chat'));
const priceOf = $derived(new Map(chatPrices.map((price) => [`${price.provider}/${price.name}`, price])));
const targetOptions = $derived(
  chatPrices
    .filter((price) => price.cost_input !== null && price.cost_output !== null)
    .map((price) => `${price.provider}/${price.name}`)
    .sort(),
);

const usedPrices = $derived.by(() => {
  const used: ModelPrice[] = [];

  for (const row of usage) {
    const price = priceOf.get(`${row.provider}/${row.model}`);

    if (price) {
      used.push(price);
    }
  }

  return used;
});

// A model the catalog lists only as an embedding or a decision model has no
// chat price, so it is left out and never gets a chat model suggested.
const whatIfRows = $derived.by(() => {
  const picked = priceOf.get(target);
  const priced = usage.filter((row) => row.cost > 0 && priceOf.has(`${row.provider}/${row.model}`));

  return priced.slice(0, MAX_ROWS).map((row) => {
    if (picked) {
      return { row: row, price: picked, cost: costAt(row, picked) };
    }

    return { row: row, ...(cheapestSwitch(row, usedPrices) ?? { price: null, cost: null }) };
  });
});

const whatIfSaving = $derived.by(() => {
  let saving = 0;

  for (const { row, cost } of whatIfRows) {
    if (cost !== null && cost < row.cost) {
      saving += row.cost - cost;
    }
  }

  return saving;
});

// A model answered only from the cache has no cost to estimate from, so it
// stays listed with its saving unknown.
const cacheRows = $derived(
  usage
    .filter((row) => row.gatewayCacheHits > 0)
    .map((row) => ({ row: row, saved: cacheSaved(row) }))
    .sort((a, b) => (b.saved ?? -1) - (a.saved ?? -1)),
);
const cacheTotal = $derived(cacheRows.reduce((sum, { saved }) => sum + (saved ?? 0), 0));

const rankedKeys = $derived(rankKeys(points, previousPoints));
const keyName = $derived(new Map(keys.map((key) => [key.id, key.name])));
const keySpend = $derived(rankedKeys.reduce((sum, key) => sum + key.cost, 0));
const idle = $derived(idleKeys(keys, points, windowStart, new Date()));

/**
 * How a key's spend moved against the window before, or 'New' for a key that
 * spent nothing then.
 */
function change(cost: number, previous: number): string {
  if (savings.value?.previousFailed) {
    return '—';
  }

  if (previous <= 0) {
    return 'New';
  }

  const percent = Math.round(((cost - previous) / previous) * 100);

  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function date(value: string): string {
  return DATE.format(new Date(value));
}
</script>

{#snippet modelName(name: string)}
	{@const [provider, ...rest] = name.split('/')}
	<span class="flex min-w-0 items-center gap-[7px]" title={name}>
		<span class="size-[7px] flex-none rounded-full" style:background={providerTone(provider ?? '').color}></span>
		<code class="truncate font-mono text-[12px] text-zinc-200"><span class="text-zinc-500">{provider}/</span>{rest.join('/')}</code>
	</span>
{/snippet}

{#if failed}
	<div class="flex items-center gap-3 text-[13px] text-zinc-400">
		Could not load savings.
		<ToolbarButton onclick={load}>Retry</ToolbarButton>
	</div>
{:else}
	<StatGrid compact>
		<StatCard compact label="Spend" value={loading ? '—' : fmtSpend(totalSpend)} />
		<StatCard compact label="Possible saving" value={loading ? '—' : fmtSpend(whatIfSaving)} />
		<StatCard compact label="Saved by cache" value={loading ? '—' : `~${fmtSpend(cacheTotal)}`} />
		<StatCard compact label="Idle API keys" value={loading || keysFailed ? '—' : String(idle.length)} />
	</StatGrid>

	<div class="flex flex-col gap-[var(--analytics-gap)]">
		<ChartCard title="Model what-if" hint="Your top models' tokens at another model's list price. Estimates: quality isn't considered.">
			{#snippet actions()}
				<FilterPicker id="savings-target" label="Target model" options={targetOptions} bind:value={target} allLabel="Cheapest you already use" class="w-64" />
			{/snippet}
			<div class="flex flex-col gap-0.5 pb-1">
				<div class="grid grid-cols-[minmax(0,1.2fr)_72px_minmax(0,1.2fr)_72px_72px] gap-3 pb-1 text-[11px] text-zinc-500">
					<span>Model</span><span class="text-right">Spend</span><span>Switch to</span><span class="text-right">Would cost</span><span class="text-right">Saves</span>
				</div>
				{#each whatIfRows as { row, price, cost } (`${row.provider}/${row.model}`)}
					{@const saving = cost === null ? null : row.cost - cost}
					<div class="grid grid-cols-[minmax(0,1.2fr)_72px_minmax(0,1.2fr)_72px_72px] items-center gap-3 py-0.5 text-[12.5px] tabular-nums">
						{@render modelName(`${row.provider}/${row.model}`)}
						<span class="text-right text-zinc-300">{fmtSpend(row.cost)}</span>
						{#if price}
							{@render modelName(`${price.provider}/${price.name}`)}
						{:else}
							<span class="text-zinc-600">Already the cheapest</span>
						{/if}
						<span class="text-right text-zinc-400">{cost === null ? '—' : fmtSpend(cost)}</span>
						<span class="text-right {saving !== null && saving > 0 ? 'text-emerald-400' : 'text-zinc-500'}">
							{saving === null ? '—' : saving > 0 ? fmtSpend(saving) : `+${fmtSpend(-saving)}`}
						</span>
					</div>
				{:else}
					<p class="py-4 text-[12.5px] text-zinc-500">{loading ? 'Loading…' : 'No priced spend in this window.'}</p>
				{/each}
			</div>
		</ChartCard>

		<ChartCard title="API keys driving cost" hint="Keys by spend, against the window before. Open one to see the users behind it.">
			<div class="flex flex-col gap-0.5 pb-1">
				<div class="grid grid-cols-[minmax(0,1fr)_minmax(80px,160px)_72px_56px_72px_minmax(0,1.2fr)] gap-3 pb-1 text-[11px] text-zinc-500">
					<span>Key</span><span>Share of spend</span><span class="text-right">Spend</span><span class="text-right">Change</span><span class="text-right">Per request</span><span>Top model</span>
				</div>
				{#each rankedKeys.slice(0, MAX_ROWS) as key (key.id)}
					<div class="grid grid-cols-[minmax(0,1fr)_minmax(80px,160px)_72px_56px_72px_minmax(0,1.2fr)] items-center gap-3 py-0.5 text-[12.5px] tabular-nums">
						<a href="/analytics/users?actor={key.id}" class="truncate text-zinc-200 hover:text-sky-300" title={key.id}>{keyName.get(key.id) ?? 'Unknown API key'}</a>
						<span class="flex items-center gap-2">
							<span class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-6">
								<span class="block h-full rounded-full bg-emerald-500" style:width="{key.share * 100}%"></span>
							</span>
							<span class="w-8 flex-none text-right text-[11.5px] text-zinc-500">{Math.round(key.share * 100)}%</span>
						</span>
						<span class="text-right text-zinc-200">{fmtSpend(key.cost)}</span>
						<span class="text-right text-zinc-400">{change(key.cost, key.previous)}</span>
						<span class="text-right text-zinc-400">{key.requests > 0 ? fmtCost(key.cost / key.requests) : '—'}</span>
						<span class="flex min-w-0 items-center gap-2">
							<span class="min-w-0 flex-1">{@render modelName(key.topModel)}</span>
							<span class="flex-none text-[11.5px] text-zinc-500">{Math.round(key.topModelShare * 100)}%</span>
						</span>
					</div>
				{:else}
					<p class="py-4 text-[12.5px] text-zinc-500">{loading ? 'Loading…' : 'No API key spend in this window.'}</p>
				{/each}
				{#if rankedKeys.length > MAX_ROWS}
					<p class="pt-1 text-[12px] text-zinc-500">
						{fmt(rankedKeys.length - MAX_ROWS)} more keys, {fmtSpend(keySpend - rankedKeys.slice(0, MAX_ROWS).reduce((sum, key) => sum + key.cost, 0))} between them.
					</p>
				{/if}
			</div>
		</ChartCard>

		<div class="grid grid-cols-1 gap-[var(--analytics-gap)] xl:grid-cols-2 [&>*]:min-w-0">
			<ChartCard title="Saved by the gateway cache" hint="Estimated: each hit at the model's average cost for a request it answered.">
				<div class="flex flex-col gap-0.5 pb-1">
					<div class="grid grid-cols-[minmax(0,1fr)_56px_56px_72px] gap-3 pb-1 text-[11px] text-zinc-500">
						<span>Model</span><span class="text-right">Hits</span><span class="text-right">Hit rate</span><span class="text-right">Saved</span>
					</div>
					{#each cacheRows.slice(0, MAX_ROWS) as { row, saved } (`${row.provider}/${row.model}`)}
						<div class="grid grid-cols-[minmax(0,1fr)_56px_56px_72px] items-center gap-3 py-0.5 text-[12.5px] tabular-nums">
							{@render modelName(`${row.provider}/${row.model}`)}
							<span class="text-right text-zinc-400">{fmt(row.gatewayCacheHits)}</span>
							<span class="text-right text-zinc-400">{Math.round((row.gatewayCacheHits / row.requests) * 100)}%</span>
							<span class="text-right {saved === null ? 'text-zinc-500' : 'text-emerald-400'}" title={saved === null ? 'Every request was a cache hit, so there is no cost to estimate from' : undefined}>{saved === null ? '—' : `~${fmtSpend(saved)}`}</span>
						</div>
					{:else}
						<p class="py-4 text-[12.5px] text-zinc-500">{loading ? 'Loading…' : 'No cache hits in this window.'}</p>
					{/each}
				</div>
			</ChartCard>

			<ChartCard title="Idle API keys" hint="Live keys, older than this window, with no requests in it. Candidates to revoke.">
				{#snippet actions()}
					<a href="/keys" class="text-[12px] text-sky-400 hover:text-sky-300">Manage keys</a>
				{/snippet}
				<div class="flex flex-col gap-0.5 pb-1">
					<div class="grid grid-cols-[minmax(0,1fr)_96px_96px] gap-3 pb-1 text-[11px] text-zinc-500">
						<span>Key</span><span>Created</span><span class="text-right">Lifetime requests</span>
					</div>
					{#each idle.slice(0, MAX_ROWS) as key (key.id)}
						<div class="grid grid-cols-[minmax(0,1fr)_96px_96px] items-center gap-3 py-0.5 text-[12.5px] tabular-nums">
							<span class="truncate text-zinc-200" title={key.id}>{key.name}</span>
							<span class="text-zinc-500">{date(key.created_at)}</span>
							<span class="text-right text-zinc-400">{fmt(key.total_requests)}</span>
						</div>
					{:else}
						<p class="py-4 text-[12.5px] text-zinc-500">{loading ? 'Loading…' : keysFailed ? 'Could not load API keys.' : 'No idle keys in this window.'}</p>
					{/each}
					{#if idle.length > MAX_ROWS}
						<p class="pt-1 text-[12px] text-zinc-500">{fmt(idle.length - MAX_ROWS)} more.</p>
					{/if}
				</div>
			</ChartCard>
		</div>
	</div>
{/if}
