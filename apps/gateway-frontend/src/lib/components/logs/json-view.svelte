<script lang="ts">
import type { TokenKind } from '$lib/data/json-highlight';
import { HIGHLIGHT_LIMIT, tokenizeJson } from '$lib/data/json-highlight';

/**
 * The 'JSON' rendering of a stored payload, syntax highlighted.
 *
 * Tokens are rendered through {#each} rather than {@html} - see the note in
 * json-highlight.ts. Payloads are untrusted text.
 */
let { json }: { json: string } = $props();

const COLORS: Record<TokenKind, string> = {
  key: '#60a5fa',
  string: '#34d399',
  number: '#f59e0b',
  keyword: '#c084fc',
  // Braces, commas and indentation recede so the values carry the eye.
  punctuation: '#52525b',
};

// Null above the limit, which the template reads as "render it plain".
const tokens = $derived(json.length > HIGHLIGHT_LIMIT ? null : tokenizeJson(json));
</script>

<!-- Everything inside <pre> stays on one line in the template: Svelte preserves
     whitespace there, so a newline between {#each} and <span> would be printed
     into the payload as stray indentation. -->
<pre
	class="m-0 max-h-72 overflow-auto px-[13px] py-3 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap"
>{#if tokens}{#each tokens as token, index (index)}<span style:color={COLORS[token.kind]}>{token.text}</span>{/each}{:else}<span class="text-zinc-400">{json}</span>{/if}</pre>
