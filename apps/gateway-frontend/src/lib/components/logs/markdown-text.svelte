<script lang="ts">
import { renderMarkdown } from '$lib/data/markdown';

let { text }: { text: string } = $props();
const html = $derived(renderMarkdown(text));
</script>

<!-- Raw HTML is disabled in the parser; only parser-generated markup is rendered. -->
<div class="markdown min-w-0 max-w-full overflow-x-auto text-[12.5px] leading-[1.6] break-words text-zinc-300">
  {@html html}
</div>

<style>
.markdown :global(p), .markdown :global(ul), .markdown :global(ol), .markdown :global(blockquote), .markdown :global(pre), .markdown :global(table) { margin: 0 0 .75em; }
.markdown :global(> :last-child) { margin-bottom: 0; }
.markdown :global(h1), .markdown :global(h2), .markdown :global(h3), .markdown :global(h4), .markdown :global(h5), .markdown :global(h6) { margin: 1em 0 .4em; font-weight: 600; line-height: 1.4; }
.markdown :global(> :first-child) { margin-top: 0; }
.markdown :global(h1) { font-size: 1.4em; }
.markdown :global(h2) { font-size: 1.2em; }
.markdown :global(ul) { list-style: disc; padding-left: 1.5em; }
.markdown :global(ol) { list-style: decimal; padding-left: 1.5em; }
.markdown :global(li + li) { margin-top: .2em; }
.markdown :global(a) { color: var(--color-emerald-400); text-decoration: underline; overflow-wrap: anywhere; }
.markdown :global(blockquote) { border-left: 2px solid var(--color-line-strong); padding-left: .8em; color: var(--color-zinc-400); }
.markdown :global(code) { font-family: var(--font-mono); background: var(--color-surface-3); border-radius: 4px; padding: .1em .3em; }
.markdown :global(pre) { max-width: 100%; overflow-x: auto; padding: .75em; background: var(--color-surface-3); border: 1px solid var(--color-line); border-radius: 6px; white-space: pre; }
.markdown :global(pre code) { padding: 0; background: transparent; }
.markdown :global(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown :global(th), .markdown :global(td) { border: 1px solid var(--color-line-strong); padding: .4em .7em; }
.markdown :global(th) { background: var(--color-surface-3); font-weight: 600; }
.markdown :global(hr) { border-color: var(--color-line-strong); margin: 1em 0; }
</style>
