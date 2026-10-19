<script lang="ts">
import { HIGHLIGHT_LIMIT, TOKEN_COLORS, tokenizeJson } from '$lib/data/json-highlight';

/**
 * An editable JSON box, coloured like JsonView.
 *
 * A textarea with transparent text sits over a highlighted copy of the same
 * text. Both share one grid cell, font and padding, so the caret and selection
 * line up with the colours underneath, and the box grows with its content.
 */
let {
  value = $bindable(),
  disabled = false,
  label,
}: {
  value: string;
  disabled?: boolean;
  label: string;
} = $props();

const tokens = $derived(value.length <= HIGHLIGHT_LIMIT ? tokenizeJson(value) : null);

const LAYER_CLASS =
  'col-start-1 row-start-1 m-0 px-[11px] py-2 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap';
</script>

<div
	class="grid max-h-[640px] min-h-[240px] overflow-auto rounded-lg border border-line-strong bg-surface-3 focus-within:border-emerald-500 focus-within:ring-[3px] focus-within:ring-emerald-500/12 {disabled
		? 'opacity-50'
		: ''}"
>
	<!-- The trailing space keeps a final empty line from collapsing, which would
	     leave the textarea one line taller than the colours under it. -->
	<pre aria-hidden="true" class="pointer-events-none {LAYER_CLASS}">{#if tokens}{#each tokens as token, index (index)}<span style:color={TOKEN_COLORS[token.kind]}>{token.text}</span>{/each}{:else}<span class="text-zinc-400">{value}</span>{/if} </pre>
	<textarea
		bind:value
		aria-label={label}
		spellcheck={false}
		autocomplete="off"
		{disabled}
		class="resize-none overflow-hidden border-0 bg-transparent text-transparent caret-zinc-100 outline-none selection:bg-emerald-500/25 {LAYER_CLASS}"
	></textarea>
</div>
