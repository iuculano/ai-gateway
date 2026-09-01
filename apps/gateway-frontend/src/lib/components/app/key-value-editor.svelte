<script module lang="ts">
export interface Pair {
  key: string;
  value: string;
}

/**
 * The editor works on an ordered array, not on the `Record<string, string>` the
 * API takes.
 *
 * A record cannot hold the state this control spends most of its life in: a row
 * that has been added but not yet typed into has no key, and two half-typed rows
 * would collide on the empty string and silently eat each other.
 */
export function toPairs(record?: Record<string, string> | null): Pair[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}

/**
 * Back to the API's shape, dropping rows with no key.
 *
 * Returns undefined rather than `{}` for an empty map: the column is nullable,
 * and an empty filter would otherwise read as "match nothing" when the intent
 * was to clear it.
 */
export function toRecord(pairs: Pair[]): Record<string, string> | undefined {
  const entries = pairs.map(({ key, value }) => [key.trim(), value.trim()] as const).filter(([key]) => key.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
</script>

<script lang="ts">
import { Input } from '$lib/components/ui/input';

/**
 * The key/value map editor behind a webhook's filter and its tags.
 *
 * Both are `jsonb` string maps on the backend and neither has a fixed set of
 * keys, so this is a repeated pair of text boxes rather than a picker.
 */
let {
  pairs = $bindable(),
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add pair',
  disabled = false,
}: {
  pairs: Pair[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  disabled?: boolean;
} = $props();

const FIELD_CLASS =
  'h-9 rounded-lg border-line-strong bg-surface-3 px-[11px] font-mono text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';
</script>

<div class="flex flex-col gap-2">
	{#each pairs as _pair, index (index)}
		<div class="flex items-center gap-2">
			<Input bind:value={pairs[index].key} placeholder={keyPlaceholder} class={FIELD_CLASS} {disabled} />
			<span class="flex-none text-[12.5px] text-zinc-600">=</span>
			<Input bind:value={pairs[index].value} placeholder={valuePlaceholder} class={FIELD_CLASS} {disabled} />
			<button
				type="button"
				class="flex size-9 flex-none items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-50"
				aria-label="Remove pair"
				{disabled}
				onclick={() => (pairs = pairs.filter((_, i) => i !== index))}
			>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
			</button>
		</div>
	{/each}

	<button
		type="button"
		class="flex h-9 w-fit items-center gap-[7px] rounded-lg border border-dashed border-line-strong px-3 text-[12.5px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-50"
		{disabled}
		onclick={() => (pairs = [...pairs, { key: '', value: '' }])}
	>
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
		{addLabel}
	</button>
</div>
