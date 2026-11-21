<script lang="ts">
import type { SeriesPoint } from '#lib/api/analytics.ts';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { fmtDollars } from '#lib/data/format.ts';
import { spendDrivers, spendEffects } from '#lib/data/spend-drivers.ts';

interface Props {
  current: SeriesPoint[];
  previous: SeriesPoint[] | null;
  loading: boolean;
  unavailable: boolean;
  onretry: () => void;
}

let { current, previous, loading, unavailable, onretry }: Props = $props();

const attribution = $derived(spendDrivers(current, previous ?? []));
const shown = $derived(spendEffects(attribution));
const largest = $derived(Math.max(0, ...shown.effects.map((effect) => Math.abs(effect.amount ?? 0))));

function money(value: number): string {
  return fmtDollars(value, shown.decimals);
}

/**
 * Amber for a step that added to spend and green for one that took it away.
 */
function color(amount: number | null): string {
  if (!amount) {
    return '#a1a1aa';
  }

  return amount > 0 ? '#fbbf24' : '#34d399';
}
</script>

<div class="h-[calc(160px+var(--analytics-body-growth,0px))] overflow-auto">
    {#if loading}
        <div class="flex h-full items-center justify-center text-[12.5px] text-zinc-500">Loading spend comparison…</div>
    {:else if unavailable}
        <div class="flex h-full flex-wrap content-center items-center justify-center gap-3 text-[12.5px] text-zinc-500">
            <span>Spend comparison unavailable.</span>
            <ToolbarButton onclick={onretry}>Retry comparison</ToolbarButton>
        </div>
    {:else}
        <dl class="text-[12px]">
            <div class="flex h-6 items-center justify-between gap-3 border-b border-line text-zinc-400">
                <dt>Previous-period spend</dt><dd class="font-mono tabular-nums">{money(attribution.previousSpend)}</dd>
            </div>
            {#each shown.effects as effect (effect.label)}
                <div class="grid h-6 grid-cols-[140px_minmax(0,1fr)_minmax(90px,auto)] items-center gap-3" title={effect.description}>
                    <dt class="text-zinc-300">{effect.label}</dt>
                    <dd class="h-1.5" aria-hidden="true"><div class="h-full rounded-sm" style:background={color(effect.amount)} style:width={`${largest > 0 ? Math.abs(effect.amount ?? 0) / largest * 100 : 0}%`}></div></dd>
                    <dd class="text-right font-mono font-medium whitespace-nowrap tabular-nums" style:color={color(effect.amount)}>
                        {effect.amount === null ? '—' : `${effect.amount > 0 ? '+' : effect.amount < 0 ? '−' : ''}${money(Math.abs(effect.amount))}`}
                    </dd>
                </div>
            {/each}
            <div class="flex h-6 items-center justify-between gap-3 border-t border-line font-medium text-zinc-200">
                <dt>Current-period spend</dt><dd class="font-mono tabular-nums">{money(attribution.currentSpend)}</dd>
            </div>
        </dl>
        <p class="mt-1 text-[11px] leading-4 text-zinc-500">
            {#if !attribution.steps}
                {attribution.currentSpend === 0 && attribution.previousSpend === 0 ? 'No previous requests to compare.' : 'No previous requests; there is no baseline to split this change.'}
            {:else}
                Estimated contributions, applied top to bottom.
                {#if attribution.includesNewModels}New models count toward model mix at their current cost/request.{/if}
            {/if}
        </p>
    {/if}
</div>
