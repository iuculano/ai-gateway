<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import { resolveActorNames } from '#lib/api/actors.ts';
import { getLogRequest, getLogResponse } from '#lib/api/logs.ts';
import type { Log, LogPayload } from '#lib/api/types.ts';
import { copyToClipboard } from '#lib/clipboard.ts';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import JsonView from '#lib/components/logs/json-view.svelte';
import MessageList from '#lib/components/logs/message-list.svelte';
import OperationPayload from '#lib/components/logs/operation-payload.svelte';
import { requestTurns, responseTurns, type Turn, turnsToText } from '#lib/data/conversation.ts';
import { fmtCost, fmtLatency, fmtThroughput, fmtTokens, fmtTs, providerTone, traceTone } from '#lib/data/format.ts';
import { finishReason, logCost } from '#lib/data/log-payloads.ts';

export type PayloadView = 'simple' | 'json';

type PayloadKind = 'request' | 'response';

interface PayloadState {
  data: LogPayload | undefined;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

interface PayloadPanel {
  title: string;
  kind: PayloadKind;
  state: PayloadState;
  json: string;
  turns: Turn[];
  present: boolean;
}

interface Props {
  log: Log;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
  view?: PayloadView;
}

let { log, cols, expanded, ontoggle, view = 'simple' }: Props = $props();

const STATUS = {
  complete: { label: 'Success', color: '#10b981' },
  failed: { label: 'Failed', color: '#f87171' },

  // Written before the provider is called and never resolved, so the request
  // died in flight. That is not the same as a failure the gateway saw.
  incomplete: { label: 'Incomplete', color: '#f59e0b' },
} as const;

const ENDPOINTS = {
  chat: '/v1/chat/completions',
  embedding: '/v1/embeddings',
  decision: '/v1/decisions',
} as const;

// Embeddings have no playground to replay into.
const REPLAY_PATHS = { chat: '/playground', decision: '/playground/decisions', embedding: null } as const;

const ts = $derived(fmtTs(log.created_at));
const tone = $derived(providerTone(log.provider));
const throughput = $derived(log.gateway_cache_hit ? '—' : fmtThroughput(log.output_tokens, log.response_time_ms));
const totalCost = $derived(logCost(log));
const status = $derived(STATUS[log.status] ?? { label: log.status, color: '#71717a' });
const replayPath = $derived(REPLAY_PATHS[log.operation]);

// Stored as a string map, which the generated API type only knows as JSON.
const tags = $derived((log.tags ?? {}) as Record<string, string>);

// Payloads live in object storage behind their own endpoints, so they are
// fetched when a row is first opened and not with the page. A list of 50 rows
// would otherwise pull 100 objects nobody has asked to see.
const payloads = $state<Record<PayloadKind, PayloadState>>({
  request: { data: undefined, loading: false, loaded: false, error: null },
  response: { data: undefined, loading: false, loaded: false, error: null },
});

const request = $derived(payloads.request.data);
const response = $derived(payloads.response.data);

let creatorName: string | null = $state(null);

async function loadPayload(kind: PayloadKind): Promise<void> {
  const state = payloads[kind];
  const isStored = kind === 'request' ? log.has_request : log.has_response;

  if (!isStored || state.loaded || state.loading) {
    return;
  }

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
  if (!expanded) {
    return;
  }

  // Opening the row is the only thing that loads. A failure waits for its
  // retry button, so nothing in here is tracked.
  untrack(() => {
    for (const kind of ['request', 'response'] as const) {
      if (!payloads[kind].error) {
        void loadPayload(kind);
      }
    }
  });
});

// The name behind the actor id, looked up once the row is opened. When it
// cannot be resolved, the id stays on show.
$effect(() => {
  const actor = { actor_type: log.actor_type, actor_id: log.actor_id };

  if (!expanded) {
    return;
  }

  let cancelled = false;

  creatorName = null;

  resolveActorNames([actor])
    .then((name) => {
      if (!cancelled) {
        creatorName = name(actor);
      }
    })
    .catch(() => {});

  return () => {
    cancelled = true;
  };
});

/**
 * A cell for one of the well-known tags, which opens on its analytics tab.
 */
function tagItem(label: string, value: string, tab: string, parameter: string): DetailItem {
  return {
    label: label,
    value: value,
    title: `See ${value} in analytics`,
    href: `/analytics/${tab}?${parameter}=${encodeURIComponent(value)}`,
    copyable: true,
  };
}

const detailItems = $derived.by((): DetailItem[] => {
  const items: DetailItem[] = [
    { label: 'Log ID', value: log.id, title: log.id, copyable: true },
    { label: 'Created at', value: fmtTs(new Date(log.created_at).toISOString()).full, mono: false },
    { label: 'Created by', value: creatorName ?? log.actor_id, title: log.actor_id, mono: false },
    { label: 'Endpoint', value: ENDPOINTS[log.operation] },
    { label: 'Throughput', value: throughput },

    // The finish reason arrives with the stored response.
    { label: 'Finish reason', value: finishReason(response) ?? '—' },
  ];

  if (tags.user_id) {
    items.push(tagItem('User', tags.user_id, 'users', 'user'));
  }

  if (tags.session_id) {
    items.push(tagItem('Session', tags.session_id, 'sessions', 'session'));
  }

  return items;
});

const panels = $derived<PayloadPanel[]>([
  {
    title: 'Request',
    kind: 'request',
    state: payloads.request,
    json: request === undefined ? '' : JSON.stringify(request, null, 2),
    turns: request === undefined ? [] : requestTurns(request),
    present: log.has_request,
  },
  {
    title: 'Response',
    kind: 'response',
    state: payloads.response,
    json: response === undefined ? '' : JSON.stringify(response, null, 2),
    turns: response === undefined ? [] : responseTurns(response),
    present: log.has_response,
  },
]);

/**
 * Copies whatever a panel has on screen.
 */
function copyPanel(event: MouseEvent, panel: PayloadPanel): void {
  event.stopPropagation();

  // The transcript when that is what is showing, because copying the JSON from
  // under it would not be what was asked for. Only chat has a transcript.
  const showsTranscript = view === 'simple' && log.operation === 'chat';
  const text = showsTranscript ? turnsToText(panel.turns) : panel.json;

  if (!text) {
    toast.error(`No ${panel.title.toLowerCase()} payload to copy`);

    return;
  }

  void copyToClipboard(text, `${panel.title} copied`);
}

// The row itself is a button, so a link inside it keeps its clicks and keys
// from toggling the row as well.
function keepFromRow(event: Event): void {
  event.stopPropagation();
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400"><span class="text-zinc-600">{ts.short} · </span>{ts.time}</span>

		<span class="text-[12.5px] text-zinc-400">{log.operation}</span>


		<span class="inline-flex min-w-0 items-center gap-[7px] text-[12.5px] text-zinc-300">
			<span class="size-[7px] flex-none rounded-full" style:background={tone.color}></span>
			<span class="overflow-hidden text-ellipsis whitespace-nowrap">{tone.label}</span>
		</span>

		<code class="overflow-hidden font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-300">
			{log.model}
		</code>

		{#if log.trace_id}
			<!-- Every request from one run carries the same colour of dot, so that a
			     trace reads as a group in the table without anyone comparing hex
			     strings. -->
			<a
				href="/traces?trace={log.trace_id}"
				title="Open this trace · {log.trace_id}"
				aria-label="Open trace {log.trace_id}"
				class="inline-flex min-w-0 items-center gap-[7px] rounded px-1 py-0.5 -mx-1 hover:bg-surface-5"
				onclick={keepFromRow}
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

		<span class="text-right text-xs text-zinc-400">{log.gateway_cache_hit ? 'Yes' : 'No'}</span>
		<span class="text-right font-mono text-xs text-zinc-400">{fmtTokens(log.cached_input_tokens)}</span>
		<span class="text-right font-mono text-xs text-zinc-400">{fmtTokens(log.input_tokens)}</span>
		<span class="text-right font-mono text-xs text-zinc-400">{fmtTokens(log.output_tokens)}</span>
		<span class="text-right font-mono text-xs text-zinc-400">{throughput}</span>
		<span class="text-right font-mono text-xs text-zinc-400" title={totalCost === null ? 'Cost unknown: no usage reported, or the model has no price' : undefined}>{totalCost === null ? '—' : fmtCost(totalCost)}</span>
		<span
			class="text-right font-mono text-xs"
			class:text-zinc-400={log.status !== 'incomplete'}
			class:text-amber-500={log.status === 'incomplete'}
		>
			{fmtLatency(log.response_time_ms)}
		</span>
    <div class="flex items-center justify-end">
			{#if log.has_request && replayPath}
				<a
					href="{replayPath}?from={log.id}"
					onclick={keepFromRow}
					onkeydown={keepFromRow}
					class="ml-auto flex h-7 shrink-0 items-center gap-[7px] rounded-lg border border-line-strong bg-surface-3 px-3 text-[12.5px] tracking-[-0.01em] text-zinc-400 hover:bg-surface-4 hover:text-zinc-200"
				>
					Replay in Playground
				</a>
			{/if}
		</div>
	{/snippet}

	{#snippet details()}
		<!-- Two even rows of four once the tags add cells, rather than six and a stub. -->
		<DetailGrid items={detailItems} cols={detailItems.length > 6 ? 4 : 6} />


		<div class="grid min-w-0 grid-cols-2 gap-3.5">
			{#each panels as panel (panel.title)}
				<Panel title={panel.title}>
					{#snippet actions()}
						<ToolbarButton disabled={!panel.json} onclick={(event) => copyPanel(event, panel)}>Copy</ToolbarButton>
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
					{:else if view === 'simple' && log.operation !== 'chat'}
						<OperationPayload
							operation={log.operation}
							kind={panel.kind}
							payload={panel.kind === 'request' ? request : response}
						/>
					{:else if view === 'simple'}
						<!-- A payload with no messages in it is a real case, since a failed
						     call stores the request and never gets a response body. Simple
						     mode says so and does not render an empty box. -->
						{#if panel.turns.length === 0}
							<div class="px-[13px] py-6 text-center text-[12.5px] text-zinc-600">
								No messages in this payload — switch to JSON to see it.
							</div>
						{:else}
							<MessageList markdown turns={panel.turns} />
						{/if}
					{:else}
						<JsonView json={panel.json} />
					{/if}
				</Panel>
			{/each}
		</div>
	{/snippet}
</ExpandableRow>
