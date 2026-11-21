<script lang="ts">
import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
import PiggyBankIcon from '@lucide/svelte/icons/piggy-bank';
import UsersIcon from '@lucide/svelte/icons/users';
import type { Snippet } from 'svelte';
import { fetchSeries, type SeriesPoint } from '#lib/api/analytics.ts';
import { RANGES, setAnalyticsFilters, windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import FilterPicker from '#lib/components/analytics/filter-picker.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import PageTabs from '#lib/components/app/page-tabs.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { Latest } from '#lib/state/latest.svelte.ts';
import { page } from '$app/state';

let { children }: { children: Snippet } = $props();

const ACCENT = '#10b981';

const TABS = [
  { id: 'overview', label: 'Overview', href: '/analytics', icon: LayoutDashboardIcon },
  { id: 'users', label: 'Users', href: '/analytics/users', icon: UsersIcon },
  { id: 'sessions', label: 'Sessions', href: '/analytics/sessions', icon: MessagesSquareIcon },
  { id: 'savings', label: 'Savings', href: '/analytics/savings', icon: PiggyBankIcon },
];

const filters = setAnalyticsFilters();

// Every provider and model seen lately, for the two pickers to offer.
const options = new Latest<SeriesPoint[]>();

let rangeOpen = $state(false);

const current = $derived(TABS.findLast((tab) => page.url.pathname.startsWith(tab.href))?.id ?? 'overview');

// Users, sessions and savings look across every model, so the model filters
// only apply to the overview. A session narrowed to one model would be a part
// of one.
const modelFilters = $derived(current === 'overview');

const providerOptions = $derived.by(() => {
  const providers = new Set<string>();

  for (const point of options.value ?? []) {
    if (point.provider) {
      providers.add(point.provider);
    }
  }

  return [...providers].sort();
});

const modelOptions = $derived.by(() => {
  const models = new Set<string>();

  for (const point of options.value ?? []) {
    if (point.model && (!filters.provider || point.provider === filters.provider)) {
      models.add(point.model);
    }
  }

  return [...models].sort();
});

function setProvider(value: string): void {
  filters.provider = value;
  filters.model = '';
}

async function fetchOptions(): Promise<SeriesPoint[]> {
  // Twice the window, and under no filters. The options then do not depend on
  // what is picked, and still offer what was only active in the window before.
  const [models] = await fetchSeries({ ...windowOf(2 * filters.range.days), groupings: [['provider', 'model']] });

  return models;
}

function loadFilterOptions(): void {
  void options.load(fetchOptions);
}

$effect(() => {
  void filters.range.id;
  loadFilterOptions();
});
</script>

<div class="analytics-layout">
	<PageHeader title="Analytics" description="Traffic, spend, users and latency across every model routed through Relay." />

	<PageTabs label="Analytics sections" tabs={TABS} {current}>
		{#if modelFilters}
			<FilterPicker id="analytics-provider" label="Provider" options={providerOptions} bind:value={() => filters.provider, setProvider} class="w-40" />
			<FilterPicker id="analytics-model" label="Model" options={modelOptions} bind:value={filters.model} class="w-52" />
			{#if options.loading}<span class="text-xs text-zinc-500" role="status">Loading filters…</span>{/if}
			{#if options.error}<ToolbarButton onclick={loadFilterOptions}>Retry filters</ToolbarButton>{/if}
		{/if}
		<div class="relative">
			<ToolbarButton onclick={() => (rangeOpen = !rangeOpen)}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" /><path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
				{filters.range.label}
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="ml-0.5"><path d="M5 6.5L8 9.5L11 6.5" stroke="#71717a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</ToolbarButton>

			{#if rangeOpen}
				<div class="absolute right-0 z-20 mt-1.5 w-[168px] overflow-hidden rounded-lg border border-line-strong bg-surface-5 py-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
					{#each RANGES as option (option.id)}
						<button
							type="button"
							class="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-6 {option.id ===
							filters.rangeId
								? 'text-zinc-100'
								: 'text-zinc-400'}"
							onclick={() => {
								filters.rangeId = option.id;
								rangeOpen = false;
							}}
						>
							{option.label}
							{#if option.id === filters.rangeId}
								<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6.5" stroke={ACCENT} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</PageTabs>

	{@render children()}
</div>

<style>
  .analytics-layout {
    --analytics-gap: 10px;
    --analytics-summary-gap: 10px;
    --analytics-body-padding: 8px;
  }

  /* Restore normal spacing gradually, reserving enough room for the charts
     near 1080p. The card sizing action accounts for these computed values. */
  @media (min-width: 1024px) and (min-height: 1080px) {
    .analytics-layout {
      --analytics-gap: clamp(10px, calc(3.333333vh - 26px), 14px);
      --analytics-summary-gap: clamp(10px, calc(8.333333vh - 80px), 20px);
      --analytics-body-padding: clamp(8px, calc(6.666667vh - 64px), 16px);
    }
  }
</style>
