<script lang="ts">
import { Input } from '$lib/components/ui/input';
import * as Select from '$lib/components/ui/select';
import { Textarea } from '$lib/components/ui/textarea';
import {
  type DraftQuestion,
  QUESTION_TYPE_COLORS,
  QUESTION_TYPES,
  type QuestionType,
} from '$lib/data/decision-questions';

let {
  question = $bindable(),
  number,
  disabled = false,
  onremove,
}: {
  question: DraftQuestion;
  /** Shown in the card's corner so a long list is easy to talk about. */
  number: number;
  disabled?: boolean;
  /** Omitted for a question that cannot be removed - the last one standing. */
  onremove?: () => void;
} = $props();

// Every control in the card is 32px tall, the same as the page's tabs and buttons.
const FIELD_CLASS =
  'rounded-lg border-line-strong bg-surface-3 px-[11px] text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';

// Borderless so the cards read as text first and controls second.
const GHOST_BUTTON_CLASS =
  'flex flex-none items-center justify-center rounded-lg text-zinc-600 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-30 disabled:hover:bg-transparent';

/** The API's minimums. A choice needs one option, a score needs two levels to place anything between. */
const MIN_OPTIONS: Record<QuestionType, number> = { predicate: 0, choice: 1, score: 2 };

const color = $derived(QUESTION_TYPE_COLORS[question.type]);

function setType(type: QuestionType) {
  question.type = type;

  while (question.options.length < MIN_OPTIONS[type]) {
    question.options.push({ value: '', description: '' });
  }
}
</script>

<div class="rounded-lg border border-l-2 border-line bg-surface-1" style:border-left-color={color}>
	<div class="flex items-start gap-2 p-2.5">
		<span class="w-5 flex-none text-right text-[11px] leading-8 text-zinc-600 tabular-nums">{number}</span>

		<Select.Root
			type="single"
			value={question.type}
			onValueChange={(type) => setType(type as QuestionType)}
			{disabled}
		>
			<Select.Trigger
				class="w-[112px] flex-none rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-3 dark:hover:bg-surface-4"
			>
				<span class="flex items-center gap-2">
					<span class="size-[7px] flex-none rounded-full" style:background={color}></span>
					{question.type}
				</span>
			</Select.Trigger>
			<Select.Content>
				{#each QUESTION_TYPES as type (type)}
					<Select.Item value={type} label={type}>
						<span class="flex items-center gap-2">
							<span class="size-[7px] flex-none rounded-full" style:background={QUESTION_TYPE_COLORS[type]}></span>
							{type}
						</span>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>

		<Input
			bind:value={question.name}
			placeholder="name"
			aria-label="Question name"
			spellcheck={false}
			{disabled}
			class="{FIELD_CLASS} h-8 w-[180px] flex-none font-mono text-zinc-200"
		/>

		<Textarea
			bind:value={question.instructions}
			placeholder={question.type === 'predicate' ? 'Is this message spam?' : 'What should the model decide?'}
			aria-label="Question instructions"
			{disabled}
			rows={1}
			class="{FIELD_CLASS} max-h-48 min-h-8 py-[5px] text-[13px] leading-5 text-zinc-100"
		/>

		<button
			type="button"
			class="{GHOST_BUTTON_CLASS} size-8"
			aria-label="Remove question"
			disabled={disabled || !onremove}
			onclick={() => onremove?.()}
		>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
		</button>
	</div>

	{#if question.type !== 'predicate'}
		<!-- Indented to sit under the type picker, so the rows read as part of
		     the question above rather than questions of their own. -->
		<div class="flex flex-col gap-1.5 border-t border-line py-2.5 pr-2.5 pl-[38px]">
			<span class="mb-0.5 text-[10.5px] font-medium tracking-[.05em] text-zinc-600 uppercase">
				{question.type === 'choice' ? 'Choices' : 'Levels, lowest first'}
			</span>

			{#each question.options as _option, index (index)}
				<div class="flex items-center gap-2">
					{#if question.type === 'score'}
						<!-- The API reports a score as a position between these numbers. -->
						<span class="w-4 flex-none text-right text-[11px] leading-8 text-zinc-500 tabular-nums">{index}</span>
					{:else}
						<span class="flex w-4 flex-none justify-end">
							<span class="size-[5px] rounded-full" style:background={color}></span>
						</span>
					{/if}
					<Input
						bind:value={question.options[index].value}
						placeholder={question.type === 'choice' ? 'value' : 'label'}
						aria-label={question.type === 'choice' ? 'Choice value' : 'Level label'}
						spellcheck={false}
						{disabled}
						class="{FIELD_CLASS} h-8 w-[150px] flex-none font-mono text-zinc-200"
					/>
					<Input
						bind:value={question.options[index].description}
						placeholder="description"
						aria-label={question.type === 'choice' ? 'Choice description' : 'Level description'}
						{disabled}
						class="{FIELD_CLASS} h-8 text-zinc-400"
					/>
					<button
						type="button"
						class="{GHOST_BUTTON_CLASS} size-8"
						aria-label={question.type === 'choice' ? 'Remove choice' : 'Remove level'}
						disabled={disabled || question.options.length <= MIN_OPTIONS[question.type]}
						onclick={() => (question.options = question.options.filter((_, i) => i !== index))}
					>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
					</button>
				</div>
			{/each}

			<button
				type="button"
				class="ml-6 flex h-7 w-fit items-center gap-[7px] rounded-md px-2 text-[12px] text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-50"
				{disabled}
				onclick={() => question.options.push({ value: '', description: '' })}
			>
				<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
				{question.type === 'choice' ? 'Add choice' : 'Add level'}
			</button>
		</div>
	{/if}
</div>
