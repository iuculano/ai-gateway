<script lang="ts">
import type { DecisionAnswer } from '$lib/api/decisions';
import { QUESTION_TYPE_COLORS } from '$lib/data/decision-questions';

/** The answers, one row each: the verdict up front, the distribution behind it. */
let { answers }: { answers: DecisionAnswer[] } = $props();

const pct = (probability: number) => `${Math.round(probability * 100)}%`;
</script>

{#snippet bar(label: string, probability: number, top: boolean)}
	<div class="grid grid-cols-[minmax(0,140px)_1fr_40px] items-center gap-2 text-[11.5px]">
		<span class="truncate font-mono {top ? 'text-zinc-200' : 'text-zinc-500'}" title={label}>{label}</span>
		<span class="h-1.5 overflow-hidden rounded-full bg-surface-4">
			<span
				class="block h-full rounded-full {top ? 'bg-emerald-500' : 'bg-zinc-600'}"
				style:width={pct(probability)}
			></span>
		</span>
		<span class="text-right text-zinc-500 tabular-nums">{pct(probability)}</span>
	</div>
{/snippet}

<div class="flex flex-col divide-y divide-line">
	<!-- Unkeyed: names are unique only because the page checks, and a duplicate
	     key would throw rather than render. -->
	{#each answers as answer}
		<div class="flex flex-col gap-2 px-3.5 py-3">
			<div class="flex items-baseline gap-2.5">
				<code class="font-mono text-[12.5px] text-zinc-200">{answer.name}</code>
				<span class="inline-flex items-center gap-1.5 text-[11px] text-zinc-600">
					<span
						class="size-[6px] rounded-full"
						style:background={answer.type === 'refusal' ? '#f59e0b' : QUESTION_TYPE_COLORS[answer.type]}
					></span>
					{answer.type}
				</span>

				<span class="ml-auto text-[12.5px] font-medium tabular-nums">
					{#if answer.type === 'refusal'}
						<span class="text-amber-400">Refused</span>
					{:else if answer.type === 'predicate'}
						<span class={answer.probability >= 0.5 ? 'text-emerald-400' : 'text-zinc-300'}>
							{answer.probability >= 0.5 ? 'true' : 'false'}
						</span>
						<span class="text-zinc-500">· {pct(answer.probability)} true</span>
					{:else if answer.type === 'choice'}
						<span class="font-mono text-emerald-400">{answer.choice}</span>
					{:else}
						<span class="text-emerald-400">{answer.score.toFixed(2)}</span>
					{/if}
					{#if answer.type !== 'refusal' && answer.type !== 'predicate' && answer.confidence != null}
						<span class="text-zinc-500">· {pct(answer.confidence)} confident</span>
					{/if}
				</span>
			</div>

			{#if answer.type === 'choice'}
				{#each answer.probabilities as entry (entry.value)}
					{@render bar(entry.value, entry.probability, entry.value === answer.choice)}
				{/each}
			{:else if answer.type === 'score'}
				{@const top = Math.round(answer.score)}
				{#each answer.probabilities as entry (entry.value)}
					{@render bar(`${entry.value} · ${entry.label}`, entry.probability, entry.value === top)}
				{/each}
			{/if}
		</div>
	{/each}
</div>
