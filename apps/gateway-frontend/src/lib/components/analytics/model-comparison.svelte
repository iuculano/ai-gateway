<script lang="ts">
import type { SeriesPoint } from '$lib/api/analytics';
import CardToolbar from '$lib/components/app/card-toolbar.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import { fmt, fmtCostTotal, fmtLatency, providerTone } from '$lib/data/format';
import { type ModelSortKey, modelComparisonRows, sortModelRows } from '$lib/data/model-comparison';

let { points, failures, loading }: { points: SeriesPoint[]; failures: SeriesPoint[]; loading: boolean } = $props();
let sortKey = $state<ModelSortKey>('requests');
let ascending = $state(false);
let view = $state<'table' | 'bars' | 'efficiency'>('table');
const views = [
  { id: 'table', label: 'Table' },
  { id: 'efficiency', label: 'Efficiency' },
  { id: 'bars', label: 'Bars' },
] satisfies { id: typeof view; label: string }[];
const rows = $derived(sortModelRows(modelComparisonRows(points, failures), sortKey, ascending));
const topModels = $derived(sortModelRows(rows, 'requests', false).slice(0, 6));
const maxRequests = $derived(Math.max(1, topModels[0]?.requests ?? 0));
const efficiencyColumns: { key: ModelSortKey; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'costPerMillion', label: '$ / 1M tokens' },
  { key: 'inputShare', label: 'Input / output' },
  { key: 'tokensPerRequest', label: 'Tokens / req' },
];
const comparisonColumns: { key: ModelSortKey; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'requests', label: 'Requests' },
  { key: 'spend', label: 'Spend' },
  { key: 'averageCost', label: 'Avg $/req' },
  { key: 'latency', label: 'Avg latency' },
  { key: 'errorRate', label: 'Error rate' },
];
const columns = $derived(view === 'efficiency' ? efficiencyColumns : comparisonColumns);
function sort(key: ModelSortKey) {
  ascending = sortKey === key ? !ascending : key === 'model';
  sortKey = key;
}
const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 4,
  }).format(value);
</script>

<div class="overflow-hidden rounded-xl border border-track bg-surface-1">
	<CardToolbar>
		<h2 class="flex h-8 items-center text-[13px] font-medium text-zinc-200">Model comparison</h2>
		<span class="text-[12.5px] text-zinc-500"><span class="font-medium text-zinc-200 tabular-nums">{loading ? '—' : rows.length.toLocaleString()}</span> models</span>
		<div class="ml-auto"><FilterTabs tabs={views} bind:value={view} /></div>
	</CardToolbar>
	{#if view === 'bars'}
		<div class="flex flex-col gap-2.5 px-[18px] py-4">
			{#if loading}
				<p class="py-6 text-center text-[13px] text-zinc-500">Loading models…</p>
			{:else}
				{#each topModels as row (row.id)}
					<div class="grid grid-cols-[minmax(80px,1.1fr)_minmax(0,1fr)_50px_56px] items-center gap-3">
						<span class="flex min-w-0 items-center gap-[9px]" title={`${row.provider} · ${row.model}`}>
							<span class="size-[7px] shrink-0 rounded-full" style:background={providerTone(row.provider).color}></span>
							<span class="truncate text-[12.5px] text-zinc-300">{row.model}</span>
						</span>
						<div class="h-[18px] w-full" aria-hidden="true">
							<div class="h-full rounded-r-[4px] bg-emerald-400" style:width={`${row.requests / maxRequests * 100}%`} style:opacity={0.35 + 0.65 * row.requests / maxRequests}></div>
						</div>
						<span class="text-right text-[12.5px] text-zinc-300 tabular-nums" title={`${row.requests.toLocaleString()} requests`}>{fmt(row.requests)}</span>
						<span class="text-right text-[12.5px] text-zinc-600 tabular-nums" title="Spend">{fmtCostTotal(row.spend)}</span>
					</div>
				{:else}
					<p class="py-6 text-center text-[13px] text-zinc-500">No requests in this window.</p>
				{/each}
				{#if rows.length > 6}<p class="text-[11px] text-zinc-600">Top 6 by request volume</p>{/if}
			{/if}
		</div>
	{:else}
	<div class="max-h-[260px] overflow-auto">
		<table class="w-full {view === 'efficiency' ? 'min-w-[520px]' : 'min-w-[640px]'} border-collapse text-[12.5px]">
			<thead class="sticky top-0 z-10 bg-surface-1">
				<tr>
					{#each columns as column (column.key)}
						<th class="border-b border-line px-1.5 py-[9px] text-[11px] font-medium tracking-[.05em] text-zinc-600 uppercase first:pl-[18px] last:pr-[18px] {column.key === 'model' ? 'text-left' : 'text-right'}"
							aria-sort={sortKey === column.key ? ascending ? 'ascending' : 'descending' : 'none'}>
							<button type="button" class="whitespace-nowrap rounded uppercase hover:text-zinc-200 focus-visible:outline-sky-400" onclick={() => sort(column.key)}>
								{column.label}<span class="ml-1 inline-block w-2" aria-hidden="true">{sortKey === column.key ? ascending ? '↑' : '↓' : ''}</span>
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if loading}
					<tr><td colspan={columns.length} class="px-[18px] py-10 text-center text-[13px] text-zinc-500">Loading models…</td></tr>
				{:else}
					{#each rows as row (row.id)}
						<tr class="h-10 border-b border-hairline transition-colors duration-100 last:border-0 hover:bg-surface-3">
							<td class="max-w-[240px] py-1 pr-3 pl-[18px]">
								<span class="flex min-w-0 items-center gap-[9px]" title={`${row.provider} · ${row.model}`}>
									<span class="size-[7px] shrink-0 rounded-full" style:background={providerTone(row.provider).color}></span>
									<span class="truncate text-[13px] font-medium text-zinc-200">{row.model}</span>
								</span>
							</td>
							{#if view === 'efficiency'}
                            <td class="px-1.5 py-1 text-right text-zinc-300 tabular-nums" title="Total spend divided by total tokens, multiplied by 1 million">{row.costPerMillion === null ? '—' : money(row.costPerMillion)}</td>
                            <td class="px-1.5 py-1">
                                {#if row.inputShare === null}
                                    <span class="block text-right text-zinc-400">—</span>
                                {:else}
                                    <div class="ml-auto w-28" title={`${row.inputTokens.toLocaleString()} input · ${row.outputTokens.toLocaleString()} output tokens`}>
                                        <div class="flex justify-end gap-1 text-[11px] tabular-nums"><span class="text-sky-400">{row.inputShare.toFixed(1)}%</span><span class="text-zinc-600">/</span><span class="text-violet-400">{(100 - row.inputShare).toFixed(1)}%</span></div>
                                        <div class="mt-1 flex h-1 overflow-hidden rounded-full bg-violet-400" aria-hidden="true"><span class="h-full bg-sky-400" style:width={`${row.inputShare}%`}></span></div>
                                    </div>
                                {/if}
                            </td>
                            <td class="py-1 pr-[18px] pl-1.5 text-right text-zinc-300 tabular-nums">{row.tokensPerRequest === null ? '—' : row.tokensPerRequest.toLocaleString('en-US', { maximumFractionDigits: 1 })}</td>
                            {:else}
							<td class="px-1.5 py-1 text-right text-zinc-300 tabular-nums">{row.requests.toLocaleString()}</td>
							<td class="px-1.5 py-1 text-right text-zinc-300 tabular-nums">{money(row.spend)}</td>
							<td class="px-1.5 py-1 text-right text-zinc-400 tabular-nums">{row.averageCost === null ? '—' : money(row.averageCost)}</td>
							<td class="px-1.5 py-1 text-right text-zinc-400 tabular-nums">{fmtLatency(row.latency)}</td>
							<td class="py-1 pr-[18px] pl-1.5 text-right tabular-nums {row.errorRate !== null && row.errorRate > 0 ? 'text-red-400' : 'text-zinc-400'}">{row.errorRate === null ? '—' : `${row.errorRate.toFixed(2)}%`}</td>
                            {/if}
						</tr>
					{:else}
						<tr><td colspan={columns.length} class="px-[18px] py-10 text-center text-[13px] text-zinc-500">No requests in this window.</td></tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
	{/if}
</div>
