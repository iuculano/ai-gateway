<script lang="ts">
import type { TokenKind } from '$lib/data/json-highlight';
import { HIGHLIGHT_LIMIT, tokenizeJson } from '$lib/data/json-highlight';

/**
 * The 'JSON' rendering of a stored payload, syntax highlighted.
 *
 * Tokens are rendered through {#each} rather than {@html} - see the note in
 * json-highlight.ts. Payloads are untrusted text.
 */
let {
  json,
  highlight = true,
}: {
  json: string;
  /**
   * Turn off while the payload is still ARRIVING.
   *
   * Highlighting rebuilds one span per token, and a $derived over a growing
   * string re-runs the whole tokenise on every append. A streamed completion
   * appends once per model token, so an 800-token answer re-highlights a log
   * that ends at 156KB - measured at 10.4 million spans over the run, which
   * pins the main thread and paints once at the end rather than progressively.
   *
   * Note the size limit below does NOT catch this: 156KB is under it. The
   * limit guards one huge payload; this guards many redraws of a growing one.
   */
  highlight?: boolean;
} = $props();

const COLORS: Record<TokenKind, string> = {
  key: '#60a5fa',
  string: '#34d399',
  number: '#f59e0b',
  keyword: '#c084fc',
  // Braces, commas and indentation recede so the values carry the eye.
  punctuation: '#52525b',
};

// Null when highlighting is off or the payload is too big, which the template
// reads as "render it plain".
const tokens = $derived(highlight && json.length <= HIGHLIGHT_LIMIT ? tokenizeJson(json) : null);
</script>

<!-- Everything inside <pre> stays on one line in the template: Svelte preserves
     whitespace there, so a newline between {#each} and <span> would be printed
     into the payload as stray indentation. -->
<pre
	class="m-0 max-h-72 overflow-auto px-[13px] py-3 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap"
>{#if tokens}{#each tokens as token, index (index)}<span style:color={COLORS[token.kind]}>{token.text}</span>{/each}{:else}<span class="text-zinc-400">{json}</span>{/if}</pre>
