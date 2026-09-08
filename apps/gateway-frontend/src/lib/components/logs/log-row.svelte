<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import { getLogRequest, getLogResponse } from '$lib/api/logs';
import type { Log, LogPayload } from '$lib/api/types';
import { copyToClipboard } from '$lib/clipboard';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import JsonView from '$lib/components/logs/json-view.svelte';
import MessageList from '$lib/components/logs/message-list.svelte';
import type { Turn } from '$lib/data/conversation';
import { requestTurns, responseTurns, turnsToText } from '$lib/data/conversation';
import { fmtCost, fmtLatency, fmtThroughput, fmtTokens, fmtTs, providerTone, traceTone } from '$lib/data/format';

export type PayloadView = 'simple' | 'json';

let {
  log,
  cols,
  expanded,
  ontoggle,
  view = 'simple',
}: {
  log: Log;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
  /**
   * Which rendering the payload panels use. Read-only here: the control lives
   * in the table's toolbar, so the page owns the value and every row follows it.
   */
  view?: PayloadView;
} = $props();

const ts = $derived(fmtTs(log.created_at));
const tone = $derived(providerTone(log.provider));
const totalTokens = $derived(
  log.input_tokens === null && log.output_tokens === null ? null : (log.input_tokens ?? 0) + (log.output_tokens ?? 0),
);
// Coerced: postgres hands `numeric` back as a string, and a stray one here
// would turn this addition into string concatenation.
const totalCost = $derived(Number(log.input_cost) + Number(log.output_cost));

const STATUS = {
  complete: { label: 'Success', color: '#10b981' },
  failed: { label: 'Error', color: '#f87171' },
  // Written before the provider is called and never resolved - the request
  // died in flight. Not the same as a failure the gateway actually observed.
  incomplete: { label: 'Pending', color: '#f59e0b' },
} as const;

const status = $derived(STATUS[log.status] ?? { label: log.status, color: '#71717a' });

// Payloads live in object storage behind their own endpoints, so they are
// fetched on first expand rather than with the page. A list of 50 rows would
// otherwise pull 100 objects nobody has asked to see.
type PayloadKind = 'request' | 'response';
interface PayloadState {
  data: LogPayload | undefined;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const payloads = $state<Record<PayloadKind, PayloadState>>({
  request: { data: undefined, loading: false, loaded: false, error: null },
  response: { data: undefined, loading: false, loaded: false, error: null },
});
const request = $derived(payloads.request.data);
const response = $derived(payloads.response.data);

async function loadPayload(kind: PayloadKind) {
  const state = payloads[kind];
  if (!log[kind === 'request' ? 'has_request' : 'has_response'] || state.loaded || state.loading) return;
  state.loading = true;
  state.error = null;

  try {
    state.data = await (kind === 'request' ? getLogRequest(log.id) : getLogResponse(log.id));
    state.loaded = true;
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Failed to load payload.';
  } finally {
    state.loading = false;
  }
}

$effect(() => {
  if (expanded) {
    // Loader state must not trigger automatic retries after a failure.
    untrack(() => {
      for (const kind of ['request', 'response'] as const) {
        if (!payloads[kind].error) void loadPayload(kind);
      }
    });
  }
});

const requestJson = $derived(request === undefined ? '' : JSON.stringify(request, null, 2));
const responseJson = $derived(response === undefined ? '' : JSON.stringify(response, null, 2));

// The expanded detail cells the backend cannot answer from the row alone come
// out of the request/response payloads once they arrive.
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const temperature = $derived.by(() => {
  const value = asRecord(request).temperature;
  return typeof value === 'number' ? String(value) : '—';
});

const finishReason = $derived.by(() => {
  const choices = asRecord(response).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '—';
  const reason = asRecord(choices[0]).finish_reason;
  return typeof reason === 'string' ? reason : '—';
});

/** The response body carries the model id the provider actually served. */
const servedModel = $derived.by(() => {
  const value = asRecord(response).model;
  return typeof value === 'string' ? value : log.model;
});

const detailItems: DetailItem[] = $derived([
  { label: 'Log ID', value: log.id },
  { label: 'Endpoint', value: '/v1/chat/completions' },
  { label: 'Model served', value: servedModel },
  { label: 'Temperature', value: temperature },
  { label: 'Prompt tokens', value: fmtTokens(log.input_tokens) },
  { label: 'Completion tokens', value: fmtTokens(log.output_tokens) },
  { label: 'Throughput', value: fmtThroughput(log.output_tokens, log.response_time_ms) },
  { label: 'Finish reason', value: finishReason },
]);

const panels = $derived([
  {
    title: 'Request',
    kind: 'request' as const,
    state: payloads.request,
    json: requestJson,
    turns: request === undefined ? [] : requestTurns(request),
    present: log.has_request,
  },
  {
    title: 'Response',
    kind: 'response' as const,
    state: payloads.response,
    json: responseJson,
    turns: response === undefined ? [] : responseTurns(response),
    present: log.has_response,
  },
]);

/**
 * Copy hands over whatever is on screen.
 *
 * Copying the JSON while the panel shows a transcript would be a small lie, and
 * the transcript is the more useful thing to paste when that is the view you
 * deliberately switched to.
 */
function copyText(panel: { json: string; turns: Turn[] }): string {
  return view === 'json' ? panel.json : turnsToText(panel.turns);
}

function copy(text: string, label: string) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    if (!text) {
      toast.error(`No ${label.toLowerCase()} payload to copy`);
      return;
    }
    void copyToClipboard(text, `${label} copied`);
  };
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400"><span class="text-zinc-600">{ts.short} · </span>{ts.time}</span>

		<span class="inline-flex min-w-0 items-center gap-[7px] text-[12.5px] text-zinc-300">
			<span class="size-[7px] flex-none rounded-full" style:background={tone.color}></span>
			<span class="overflow-hidden text-ellipsis whitespace-nowrap">{tone.label}</span>
		</span>

		<code class="overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-300">
			{log.model}
		</code>

		{#if log.trace_id}
			<!-- The dot is the correlation cue: every request from one run carries the
			     same colour, so a trace reads as a group in the table without anyone
			     comparing hex strings. stopPropagation because the whole row is a
			     toggle, and following the link should not also expand the payload. -->
			<a
				href="/traces?trace={log.trace_id}"
				title="Open this trace · {log.trace_id}"
				aria-label="Open trace {log.trace_id}"
				class="inline-flex min-w-0 items-center gap-[7px] rounded px-1 py-0.5 -mx-1 hover:bg-surface-5"
				onclick={(event) => event.stopPropagation()}
			>
				<span class="size-[7px] flex-none rounded-[2px]" style:background={traceTone(log.trace_id)}></span>
				<span class="overflow-hidden font-mono text-[11.5px] text-ellipsis whitespace-nowrap text-zinc-400">
					{log.trace_id.slice(0, 8)}
				</span>
			</a>
		{:else}
			<span class="font-mono text-[11.5px] text-zinc-700">—</span>
		{/if}

		<span class="inline-flex items-center gap-1.5 text-xs font-medium" style:color={status.color}>
			<span class="size-1.5 flex-none rounded-full" style:background={status.color}></span>{status.label}
		</span>

		<span class="text-right font-mono text-xs text-zinc-400">{fmtTokens(totalTokens)}</span>
		<span class="text-right font-mono text-xs text-zinc-400">{fmtCost(totalCost)}</span>
		<span
			class="text-right font-mono text-xs"
			class:text-zinc-400={log.status !== 'incomplete'}
			class:text-amber-500={log.status === 'incomplete'}
		>
			{fmtLatency(log.response_time_ms)}
		</span>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} />

		<!-- An anchor, not a ToolbarButton, because this navigates. The playground
		     reads ?from= and rehydrates the stored request.

		     Only offered when the payload actually exists: `ai-log-omit-request`
		     leaves a row whose request was never written, and there is nothing
		     to replay from that. -->
		<div class="flex items-center gap-2.5">
			{#if log.has_request}
				<a
					href="/playground?from={log.id}"
					class="flex h-8 items-center gap-[7px] rounded-lg border border-line-strong bg-surface-3 px-3 text-[12.5px] tracking-[-0.01em] text-zinc-400 hover:bg-surface-4 hover:text-zinc-200"
				>
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
					Replay in playground
				</a>
				<span class="text-[11.5px] text-zinc-600">Re-send this request to a different model.</span>
			{:else}
				<span class="text-[11.5px] text-zinc-600">
					No stored request, so this call cannot be replayed.
				</span>
			{/if}
		</div>

		<div class="grid grid-cols-2 gap-3.5">
			{#each panels as panel (panel.title)}
				<Panel title={panel.title}>
					{#snippet actions()}
						<ToolbarButton disabled={!panel.json} onclick={copy(copyText(panel), panel.title)}>Copy</ToolbarButton>
					{/snippet}
					{#if panel.state.loading}
						<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">Loading payload…</div>
					{:else if panel.state.error}
						<div class="flex flex-col items-center gap-3 px-[13px] py-6">
							<span role="alert" class="text-[12.5px] text-red-400">{panel.state.error}</span>
							<ToolbarButton onclick={() => void loadPayload(panel.kind)}>Retry {panel.kind}</ToolbarButton>
						</div>
					{:else if !panel.present}
						<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">
							No {panel.title.toLowerCase()} payload was stored.
						</div>
					{:else if !panel.json}
						<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">
							This payload is no longer available.
						</div>
					{:else if view === 'simple'}
						<!-- A payload with no messages in it is a real case - a failed call
						     stores the request but never gets a response body - so simple
						     mode says so rather than rendering an empty box. -->
						{#if panel.turns.length === 0}
							<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">
								No messages in this payload — switch to JSON to see it.
							</div>
						{:else}
							<MessageList turns={panel.turns} />
						{/if}
					{:else}
						<JsonView json={panel.json} />
					{/if}
				</Panel>
			{/each}
		</div>
	{/snippet}
</ExpandableRow>
