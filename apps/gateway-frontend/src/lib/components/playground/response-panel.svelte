<script lang="ts">
import type { Snippet } from 'svelte';
import { toast } from 'svelte-sonner';
import { copyToClipboard } from '#lib/clipboard.ts';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import JsonView from '#lib/components/logs/json-view.svelte';
import MessageList from '#lib/components/logs/message-list.svelte';
import { type Turn, turnsToText } from '#lib/data/conversation.ts';
import { fmtLatency, fmtTokens } from '#lib/data/format.ts';

// What came back, in the same two renderings the logs page offers, so that what
// the model said and what went over the wire are one click apart here too.

interface Props {
  turns: Turn[];

  /**
   * The wire form, which is a completion object for a whole response and the
   * `data:` payloads, one per line and in order, for a streamed one.
   */
  json: string;
  running: boolean;
  error: string | null;
  finishReason: string | null;

  /**
   * The gateway's trace id for the run, which finds its log rows.
   */
  traceId: string | null;

  /**
   * Titles the panel. Compare mode passes the model, so that each column names
   * itself.
   */
  label?: string;

  /**
   * The run's timing and usage, shown in the footer. Only compare mode passes
   * them, because single mode has the same two figures in the grid above.
   */
  elapsedMs?: number | null;
  tokens?: number | null;

  /**
   * Replaces the title bar's caption, for a column that names itself. Compare
   * mode puts its model selector here. The view controls then move to a row of
   * their own underneath, because a narrow column has no room for all of them
   * in one bar.
   */
  header?: Snippet;

  /**
   * Sits to the left of the view controls, and carries the run's credential.
   */
  controls?: Snippet;
}

let {
  turns,
  json,
  running,
  error,
  finishReason,
  traceId,
  label = 'Response',
  elapsedMs = null,
  tokens = null,
  header,
  controls,
}: Props = $props();

const VIEW_TABS = [
  { id: 'simple' as const, label: 'Simple' },
  { id: 'json' as const, label: 'JSON' },
];

// Why the model stopped. Only 'stop' is uneventful, so the rest are tinted,
// because a truncated answer that looks complete is the one worth catching.
const FINISH_TONES: Record<string, string> = {
  stop: '#71717a',
  length: '#f59e0b',
  tool_calls: '#c084fc',
  content_filter: '#f87171',
};

let view: 'simple' | 'json' = $state('simple');

const empty = $derived(turns.length === 0 && json.length === 0);

/**
 * Copies whatever is on screen, which is the transcript in simple mode and the
 * wire form in JSON mode.
 */
function copy(): void {
  const text = view === 'json' ? json : turnsToText(turns);

  if (!text) {
    toast.error('Nothing to copy yet.');

    return;
  }

  void copyToClipboard(text, 'Response copied');
}
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
		<!-- A response can carry no message, as when a run finished on tool calls
		     alone or was cut off before the first token. Saying so beats an empty
		     box, which reads as the model having said nothing. -->
		{#if turns.length === 0}
			<div class="px-[13px] py-10 text-center text-[12.5px] text-zinc-600">
				No message in this response — switch to JSON to see what arrived.
			</div>
		{:else}
			<MessageList {turns} class="max-h-[420px] min-h-[120px]" autoscroll={running} />
		{/if}
	{:else}
		<!-- Plain while frames are still landing, for the reason given on JsonView's
		     highlight prop. The colour returns the moment the run finishes, which
		     is when a reader sits down with the wire form. -->
		<JsonView {json} highlight={!running} />
	{/if}

	{#if finishReason || traceId || elapsedMs !== null || tokens !== null}
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
			{#if traceId}
				<!-- The gateway's trace id, with select-all so that it can be pasted
				     straight into the logs search. -->
				<span class="ml-auto inline-flex items-center gap-[7px] text-zinc-600">
					trace
					<code class="font-mono text-zinc-500 select-all">{traceId}</code>
				</span>
			{/if}
		</div>
	{/if}
</Panel>
