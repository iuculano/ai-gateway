<script lang="ts">
import { toast } from 'svelte-sonner';
import { getLogRequest, getLogResponse } from '$lib/api/logs';
import type { Log, LogPayload } from '$lib/api/types';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import JsonView from '$lib/components/logs/json-view.svelte';
import MessageList from '$lib/components/logs/message-list.svelte';
import type { Turn } from '$lib/data/conversation';
import { requestTurns, responseTurns, turnsToText } from '$lib/data/conversation';
import { fmtCost, fmtLatency, fmtThroughput, fmtTokens, fmtTs, providerTone } from '$lib/data/format';

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
let request: LogPayload | undefined = $state(undefined);
let response: LogPayload | undefined = $state(undefined);
let loading = $state(false);
let loaded = $state(false);
let payloadError: string | null = $state(null);

async function loadPayloads() {
  if (loaded || loading) return;
  loading = true;
  payloadError = null;

  // Both sides at once, and only the sides the row says exist - has_request /
  // has_response are false when the caller suppressed one with
  // ai-log-omit-request / ai-log-omit-response.
  const [req, res] = await Promise.allSettled([
    log.has_request ? getLogRequest(log.id) : Promise.resolve(undefined),
    log.has_response ? getLogResponse(log.id) : Promise.resolve(undefined),
  ]);

  if (req.status === 'fulfilled') request = req.value;
  if (res.status === 'fulfilled') response = res.value;

  // Only an error if BOTH sides failed. One missing payload is normal - it
  // expired, or was never stored - and should not blank out the other.
  if (req.status === 'rejected' && res.status === 'rejected') {
    payloadError = req.reason instanceof Error ? req.reason.message : 'Failed to load payloads.';
  }

  loaded = true;
  loading = false;
}

$effect(() => {
  if (expanded) loadPayloads();
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
    json: requestJson,
    turns: request === undefined ? [] : requestTurns(request),
    present: log.has_request,
  },
  {
    title: 'Response',
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
    navigator.clipboard?.writeText(text).catch(() => {});
    toast.success(`${label} copied`);
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

		{#if payloadError}
			<Panel>
				<div class="flex items-center gap-[9px] px-3.5 py-4 text-[12.5px] text-red-400">
					<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" /><path d="M8 5.2v3.4M8 10.8v.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
					{payloadError}
				</div>
			</Panel>
		{:else}
			<div class="grid grid-cols-2 gap-3.5">
				{#each panels as panel (panel.title)}
					<Panel title={panel.title}>
						{#snippet actions()}
							<ToolbarButton onclick={copy(copyText(panel), panel.title)}>Copy</ToolbarButton>
						{/snippet}
						{#if loading}
							<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">Loading payload…</div>
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
		{/if}
	{/snippet}
</ExpandableRow>
