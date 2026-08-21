<script lang="ts">
import type { Snippet } from 'svelte';
import { toast } from 'svelte-sonner';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import JsonView from '$lib/components/logs/json-view.svelte';
import MessageList from '$lib/components/logs/message-list.svelte';
import type { Turn } from '$lib/data/conversation';
import { turnsToText } from '$lib/data/conversation';
import { fmtLatency, fmtTokens } from '$lib/data/format';

/**
 * What came back, in the same two renderings the logs page offers - so the
 * answer to "what did the model say" and the answer to "what exactly went over
 * the wire" are one click apart here as well.
 */
let {
  turns,
  json,
  running,
  error,
  finishReason,
  logId,
  label = 'Response',
  elapsedMs = null,
  tokens = null,
  header,
  controls,
}: {
  turns: Turn[];
  /**
   * The wire form. A completion object for a whole response; the `data:`
   * payloads, one per line and in order, for a streamed one.
   */
  json: string;
  running: boolean;
  error: string | null;
  finishReason: string | null;
  /** The gateway's own log id for the run, echoed on the response. */
  logId: string | null;
  /** Titles the panel. Compare mode passes the model, so each column names itself. */
  label?: string;
  /**
   * Per-run timing and usage, shown in the footer.
   *
   * Only compare mode passes these. Single mode has the StatGrid above it, and
   * repeating the same two figures directly underneath would be noise.
   */
  elapsedMs?: number | null;
  tokens?: number | null;
  /**
   * Replaces the title bar's caption, for a column that names itself - compare
   * mode puts its model selector here.
   *
   * When supplied, the view controls move to a row of their own underneath. In
   * a 300px column a selector, two tabs and a copy button do not share 42px,
   * and the alternative was dropping one of them.
   */
  header?: Snippet;
  /** Sits to the left of the view controls. Carries the per-run credential. */
  controls?: Snippet;
} = $props();

const VIEW_TABS = [
  { id: 'simple' as const, label: 'Simple' },
  { id: 'json' as const, label: 'JSON' },
];

let view: 'simple' | 'json' = $state('simple');

const empty = $derived(turns.length === 0 && json.length === 0);

/**
 * The transcript in simple mode, the wire form in JSON mode.
 *
 * The same rule the logs page uses: copy what is on screen, because the view
 * you deliberately switched to is the one you meant to paste.
 */
function copy() {
  const text = view === 'json' ? json : turnsToText(turns);

  if (!text) {
    toast.error('Nothing to copy yet.');
    return;
  }

  navigator.clipboard?.writeText(text).catch(() => {});
  toast.success('Response copied');
}

/**
 * Why the model stopped. Only 'stop' is uneventful, so the rest are tinted -
 * a truncated answer that looks complete is the failure mode worth catching.
 */
const FINISH_TONES: Record<string, string> = {
  stop: '#71717a',
  length: '#f59e0b',
  tool_calls: '#c084fc',
  content_filter: '#f87171',
};
</script>

{#snippet viewControls()}
	<FilterTabs tabs={VIEW_TABS} bind:value={view} />
	<ToolbarButton onclick={copy}>Copy</ToolbarButton>
{/snippet}

<Panel title={header ? undefined : label} {header} actions={header ? undefined : viewControls}>
	{#if header}
		<div class="flex items-center gap-2 border-b border-line px-3 py-2">
			{#if controls}
				<div class="min-w-0 flex-1">{@render controls()}</div>
			{/if}
			<div class="ml-auto flex flex-none items-center gap-2">{@render viewControls()}</div>
		</div>
	{/if}

	{#if error}
		<div class="flex items-start gap-[9px] px-3.5 py-4 text-[12.5px] text-red-400">
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none" class="mt-px flex-none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" /><path d="M8 5.2v3.4M8 10.8v.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			<span class="break-words">{error}</span>
		</div>
	{:else if empty}
		<div class="px-[13px] py-10 text-center text-[12.5px] text-zinc-600">
			{running ? 'Waiting for the model…' : 'Nothing sent yet. Run a request to see the response here.'}
		</div>
	{:else if view === 'simple'}
		<!-- A response can legitimately carry no message: a run that finished on
		     tool calls alone, or one cut off before the first token. Saying so
		     beats an empty box that reads as "the model said nothing". -->
		{#if turns.length === 0}
			<div class="px-[13px] py-10 text-center text-[12.5px] text-zinc-600">
				No message in this response — switch to JSON to see what arrived.
			</div>
		{:else}
			<MessageList {turns} class="max-h-[420px] min-h-[120px]" autoscroll={running} />
		{/if}
	{:else}
		<!-- Unhighlighted while frames are still landing: see the note on the prop.
		     Colour returns the moment the run finishes, which is when a reader
		     actually sits and reads the wire form. -->
		<JsonView {json} highlight={!running} />
	{/if}

	{#if finishReason || logId || elapsedMs !== null || tokens !== null}
		<div class="flex flex-wrap items-center gap-3 border-t border-line px-3.5 py-2.5 text-[11.5px]">
			{#if elapsedMs !== null}
				<span class="text-zinc-500 tabular-nums">{fmtLatency(elapsedMs)}</span>
			{/if}
			{#if tokens !== null}
				<span class="text-zinc-500 tabular-nums">{fmtTokens(tokens)} tok</span>
			{/if}
			{#if finishReason}
				<span class="inline-flex items-center gap-[7px] text-zinc-500">
					<span
						class="size-[6px] flex-none rounded-full"
						style:background={FINISH_TONES[finishReason] ?? '#71717a'}
					></span>
					finish_reason
					<code class="font-mono text-zinc-300">{finishReason}</code>
				</span>
			{/if}
			{#if logId}
				<!-- The gateway's log id, select-all so it can be pasted straight into
				     the logs search rather than picked out character by character. -->
				<span class="ml-auto inline-flex items-center gap-[7px] text-zinc-600">
					log
					<code class="font-mono text-zinc-500 select-all">{logId}</code>
				</span>
			{/if}
		</div>
	{/if}
</Panel>
