<script lang="ts">
import { HIGHLIGHT_LIMIT, TOKEN_COLORS, tokenizeJson } from '#lib/data/json-highlight.ts';

// The JSON rendering of a stored payload, with syntax highlighting. Payloads
// are untrusted text, so the tokens are rendered through an each block and
// never as raw HTML.

interface Props {
  json: string;

  /**
   * Turned off while the payload is still arriving. Highlighting rebuilds one
   * span per token, and a streamed completion grows once per model token, so
   * highlighting on every append redoes the whole payload hundreds of times
   * and holds the main thread until the end. The size limit does not catch
   * this, because the payload stays well under it.
   */
  highlight?: boolean;
}

let { json, highlight = true }: Props = $props();

// Null when highlighting is off or the payload is too big, which the template
// renders plain.
const tokens = $derived(highlight && json.length <= HIGHLIGHT_LIMIT ? tokenizeJson(json) : null);
</script>

<!-- Everything inside the pre stays on one line of the template. Svelte keeps
     whitespace there, so a line break between the each block and its span would
     be printed into the payload as stray indentation. -->
<pre
	class="m-0 max-h-72 overflow-auto px-[13px] py-3 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap"
>{#if tokens}{#each tokens as token, index (index)}<span style:color={TOKEN_COLORS[token.kind]}>{token.text}</span>{/each}{:else}<span class="text-zinc-400">{json}</span>{/if}</pre>
