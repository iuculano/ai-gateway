<script lang="ts">
import type { DecisionAnswer, DecisionQuestion } from '$lib/api/decisions';
import DecisionAnswers from '$lib/components/playground/decision-answers.svelte';
import { QUESTION_TYPE_COLORS } from '$lib/data/decision-questions';

/** The Simple view of a decision or embedding payload. Chat payloads use MessageList instead. */
let {
  operation,
  kind,
  payload,
}: {
  operation: 'embedding' | 'decision';
  kind: 'request' | 'response';
  payload: unknown;
} = $props();

const record = $derived(
  typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : ({} as Record<string, unknown>),
);

const questions = $derived(Array.isArray(record.questions) ? (record.questions as DecisionQuestion[]) : []);
const answers = $derived(Array.isArray(record.answers) ? (record.answers as DecisionAnswer[]) : []);

const inputs = $derived(
  typeof record.input === 'string'
    ? [record.input]
    : Array.isArray(record.input)
      ? record.input.filter((value): value is string => typeof value === 'string')
      : [],
);

const embeddings = $derived(Array.isArray(record.data) ? (record.data as { embedding?: unknown }[]) : []);

// A float array, or base64 of little-endian float32s at four bytes each.
const dimensions = $derived.by(() => {
  const first = embeddings[0]?.embedding;
  if (Array.isArray(first)) return first.length;
  if (typeof first === 'string') return Math.floor(atob(first).length / 4);
  return null;
});

const CAPTION_CLASS = 'text-[10.5px] font-medium tracking-[.05em] text-zinc-600 uppercase';
</script>

{#snippet empty()}
	<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">
		Nothing to show here — switch to JSON to see the payload.
	</div>
{/snippet}

{#if operation === 'decision' && kind === 'request'}
	{#if typeof record.input !== 'string' && questions.length === 0}
		{@render empty()}
	{:else}
		<div class="flex flex-col gap-3.5 px-[13px] py-3">
			<div class="flex flex-col gap-1.5">
				<span class={CAPTION_CLASS}>Input</span>
				<p class="text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-zinc-300">{record.input}</p>
			</div>

			<div class="flex flex-col gap-3">
				<span class={CAPTION_CLASS}>Questions</span>
				{#each questions as question}
					<div class="flex flex-col gap-1 border-l-2 pl-3" style:border-left-color={QUESTION_TYPE_COLORS[question.type]}>
						<div class="flex items-baseline gap-2">
							<code class="font-mono text-[12.5px] text-zinc-200">{question.name}</code>
							<span class="text-[11px] text-zinc-600">{question.type}</span>
						</div>
						<p class="text-[12.5px] leading-[1.5] text-zinc-300">{question.instructions}</p>

						<!-- Options nest one level in, on a grid so the values line up and
						     long descriptions wrap under their own column. -->
						{#if question.type === 'choice' && question.choices.length > 0}
							<div
								class="mt-1 ml-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-line-strong pl-3 text-[12px] leading-[1.5]"
							>
								{#each question.choices as choice}
									<code class="font-mono text-zinc-400">{choice.value}</code>
									<span class="text-zinc-500">{choice.description}</span>
								{/each}
							</div>
						{:else if question.type === 'score' && question.levels.length > 0}
							<div
								class="mt-1 ml-0.5 grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-line-strong pl-3 text-[12px] leading-[1.5]"
							>
								{#each question.levels as level, index}
									<span class="text-right text-zinc-600 tabular-nums">{index}</span>
									<code class="font-mono text-zinc-400">{level.label}</code>
									<span class="text-zinc-500">{level.description}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
{:else if operation === 'decision'}
	{#if answers.length === 0}
		{@render empty()}
	{:else}
		<DecisionAnswers {answers} />
	{/if}
{:else if kind === 'request'}
	{#if inputs.length === 0}
		{@render empty()}
	{:else}
		<div class="flex flex-col gap-1.5 px-[13px] py-3">
			<span class={CAPTION_CLASS}>{inputs.length === 1 ? 'Input' : `${inputs.length} inputs`}</span>
			{#each inputs as text, index}
				<div class="flex gap-2.5 text-[12.5px] leading-[1.6]">
					{#if inputs.length > 1}
						<span class="w-5 flex-none text-right text-zinc-600 tabular-nums">{index}</span>
					{/if}
					<span class="min-w-0 break-words whitespace-pre-wrap text-zinc-300">{text}</span>
				</div>
			{/each}
		</div>
	{/if}
{:else if embeddings.length === 0}
	{@render empty()}
{:else}
	<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-400">
		{embeddings.length}
		{embeddings.length === 1 ? 'embedding' : 'embeddings'}{#if dimensions !== null}, {dimensions} dimensions each{/if}
	</div>
{/if}
