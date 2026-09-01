<script lang="ts">
import { onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import { page } from '$app/state';
import type { ChatCompletionMessage, ChatCompletionRequest, GatewayHeaders } from '$lib/api/chat-completions';
import { createChatCompletion, streamChatCompletion } from '$lib/api/chat-completions';
import { getLogRequest } from '$lib/api/logs';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import Panel from '$lib/components/app/panel.svelte';
import StatCard from '$lib/components/app/stat-card.svelte';
import StatGrid from '$lib/components/app/stat-grid.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import type { DraftMessage } from '$lib/components/playground/message-editor.svelte';
import MessageEditor, {
  COMPOSER_ROLES,
  type ComposerRole,
  emptyDraft,
} from '$lib/components/playground/message-editor.svelte';
import ModelPicker from '$lib/components/playground/model-picker.svelte';
import type { PromptSelection } from '$lib/components/playground/prompt-picker.svelte';
import PromptPicker from '$lib/components/playground/prompt-picker.svelte';
import ResponsePanel from '$lib/components/playground/response-panel.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Switch } from '$lib/components/ui/switch';
import { toResponsePayload } from '$lib/data/completion';
import { responseTurns } from '$lib/data/conversation';
import { fmtLatency, fmtThroughput, fmtTokens } from '$lib/data/format';
import { PlaygroundRun } from '$lib/state/playground-run.svelte';
import { webhooks } from '$lib/state/webhooks.svelte';

/**
 * The one field style this page uses, matching the create-key dialog's.
 *
 * Declared once rather than per input: the settings rail has six of them and
 * they were never going to stay in step by hand.
 */
const FIELD_CLASS =
  'h-9 rounded-lg border-line-strong bg-surface-3 px-[11px] text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';

const MONO_FIELD_CLASS = `${FIELD_CLASS} font-mono`;

// The request. Starts with a system and a user message because that is the
// shape almost every first request has; blanks are dropped on send, so the
// system row costs nothing if it goes unused.
let drafts: DraftMessage[] = $state([emptyDraft('system'), emptyDraft('user')]);

/**
 * Single sends one request; compare sends the SAME request to several models
 * and puts the answers beside each other.
 *
 * A mode rather than a second page, because everything except the model list
 * and the shape of the response area is shared - the credential, the messages,
 * the prompt, the parameters. Two pages would have drifted within a week.
 */
type Mode = 'single' | 'compare';

const MODE_TABS = [
  { id: 'single' as const, label: 'Single' },
  { id: 'compare' as const, label: 'Compare' },
];

let mode: Mode = $state('single');

const single = new PlaygroundRun('openai/gpt-5');

/** Compare mode's columns. Capped, because each one spends real money upstream. */
const MAX_COMPARISONS = 4;
let comparisons = $state([new PlaygroundRun('openai/gpt-5'), new PlaygroundRun('openai/gpt-5-mini')]);

const runs = $derived(mode === 'single' ? [single] : comparisons);
const running = $derived(runs.some((run) => run.running));

let stream = $state(true);

/** The stored prompt to expand, or null to send the messages as written. */
let promptSelection: PromptSelection | null = $state(null);

/**
 * The webhook to notify about this request, via ai-webhook-id.
 *
 * Queues one delivery for the log this request writes. Nothing fans out
 * automatically yet, so naming one here is currently the only way to put work
 * in the outbox.
 */
const NO_WEBHOOK = '__none__';
let webhookId = $state(NO_WEBHOOK);

onMount(() => {
  webhooks.endpoints.ensureLoaded();

  // The logs page links here with ?from=<log id> to replay a stored request.
  const from = page.url.searchParams.get('from');
  if (from) void loadFromLog(from);
});

// Parameters are strings, not numbers, so that "unset" is expressible. A number
// bound to an emptied field goes to NaN or 0, and sending 0 for temperature is
// a real instruction rather than an absent one.
let temperature = $state('');
let maxTokens = $state('');
let topP = $state('');

const usage = $derived(single.assembly.usage);

/**
 * One draft, as the request's discriminated union.
 *
 * Built per role rather than spread from a single object literal: `role` here
 * is a union of four literals, and an object typed that way does not narrow to
 * any one member of the union it has to satisfy.
 */
function toMessage(draft: DraftMessage): ChatCompletionMessage {
  const content = draft.content.trim();

  switch (draft.role) {
    case 'system':
      return { role: 'system', content: content };
    case 'developer':
      return { role: 'developer', content: content };
    case 'assistant':
      return { role: 'assistant', content: content };
    default:
      return { role: 'user', content: content };
  }
}

/**
 * A parameter the provider should decide, or the number the reader typed.
 *
 * Anything unparseable is treated as unset rather than sent as NaN, which the
 * request schema would reject with a message about the field rather than about
 * the typo.
 */
function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The request body, or null when the form is not ready to send.
 *
 * Empty messages are dropped rather than sent: a blank system row is the
 * page's own default, and forwarding it would put an empty instruction in front
 * of every conversation started here.
 */
function buildBody(): ChatCompletionRequest | null {
  const messages = drafts.filter((draft) => draft.content.trim().length > 0).map(toMessage);

  if (messages.length === 0) {
    toast.error('Write at least one message.');
    return null;
  }

  return {
    // Replaced by every run with its own model - that substitution is what
    // makes compare mode "the same request, several models" by construction.
    model: '',
    messages: messages,
    // A reference, not the rendered text: the gateway expands it with the same
    // code path any other caller would get, built-ins included.
    ...(promptSelection
      ? {
          prompt: {
            name: promptSelection.name,
            version: promptSelection.version,
            variables: promptSelection.variables,
          },
        }
      : {}),
    temperature: optionalNumber(temperature),
    max_completion_tokens: optionalNumber(maxTokens),
    top_p: optionalNumber(topP),
  };
}

function buildHeaders(): GatewayHeaders {
  return {
    // Replaced by every run with its own credential, the same way `model` is.
    'ai-api-key': '',
    ...(webhookId !== NO_WEBHOOK ? { 'ai-webhook-id': webhookId } : {}),
  };
}

async function run() {
  if (running) return;

  const targets = runs.filter((entry) => entry.model.trim().length > 0);
  if (targets.length === 0) {
    toast.error('Name at least one model to send this to.');
    return;
  }

  // Per column, because each spends its own credential. Named rather than
  // counted: with four columns, "a key is missing" does not say which one.
  const unkeyed = targets.filter((entry) => entry.apiKey.trim().length === 0);
  if (unkeyed.length > 0) {
    toast.error(`Paste the provider API key for ${unkeyed.map((entry) => entry.model.trim()).join(', ')}.`);
    return;
  }

  const body = buildBody();
  if (!body) return;

  const headers = buildHeaders();

  // In flight together, not one after another: the point of comparing is to see
  // the answers arrive against each other. PlaygroundRun.send never throws, so
  // one provider refusing a key cannot cancel the rest.
  await Promise.all(targets.map((entry) => entry.send(headers, body, stream)));
}

function stop() {
  for (const entry of runs) {
    entry.stop();
  }
}

function addComparison() {
  if (comparisons.length >= MAX_COMPARISONS) return;
  comparisons.push(new PlaygroundRun(''));
}

function removeComparison(index: number) {
  comparisons = comparisons.filter((_, position) => position !== index);
}

/**
 * Loads a stored request off a log, for re-running it against another model.
 *
 * The stored payload is what the gateway actually sent, which matters: a
 * request that named a prompt was already expanded into a system message before
 * it was logged, so replaying it reproduces the historical wording rather than
 * whatever the active prompt version says today.
 *
 * @param id
 * The log to read the request from.
 */
async function loadFromLog(id: string) {
  try {
    const payload = (await getLogRequest(id)) as Partial<ChatCompletionRequest> | null;

    if (!payload?.messages?.length) {
      toast.error('That log has no stored request to replay.');
      return;
    }

    drafts = payload.messages
      .filter((message): message is Extract<ChatCompletionMessage, { role: ComposerRole }> =>
        (COMPOSER_ROLES as readonly string[]).includes(message.role),
      )
      .map((message) => ({
        role: message.role,
        // Content can arrive as parts rather than a string; the composer edits
        // text, so the parts are flattened rather than dropped.
        content:
          typeof message.content === 'string'
            ? message.content
            : (message.content ?? []).map((part) => ('text' in part ? part.text : '')).join(''),
      }));

    if (typeof payload.model === 'string' && payload.model.length > 0) {
      single.model = payload.model;
      // Seeded rather than overwritten wholesale: the original model is the
      // baseline you are comparing a candidate against.
      if (comparisons[0]) comparisons[0].model = payload.model;
    }

    temperature = payload.temperature != null ? String(payload.temperature) : '';
    maxTokens = payload.max_completion_tokens != null ? String(payload.max_completion_tokens) : '';
    topP = payload.top_p != null ? String(payload.top_p) : '';

    toast.success('Loaded the request from that log');
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : 'Could not read that log.');
  }
}

function clear() {
  if (running) return;

  drafts = [emptyDraft('system'), emptyDraft('user')];
  for (const entry of runs) {
    entry.reset();
  }
}

function addMessage() {
  // Alternating, because the reason to add a message under a user turn is
  // almost always to write the assistant's half of a few-shot example.
  drafts.push(emptyDraft(drafts.at(-1)?.role === 'user' ? 'assistant' : 'user'));
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
  }
}
</script>

<svelte:window onkeydown={onKeydown} />

<PageHeader
	title="Playground"
	description="Send a request through Relay to any model your provider key can reach, streamed or whole."
>
	{#snippet actions()}
		<FilterTabs tabs={MODE_TABS} bind:value={mode} />
		<ToolbarButton disabled={running} onclick={clear}>Clear</ToolbarButton>
		{#if running}
			<ToolbarButton onclick={stop}>
				<span class="size-[7px] rounded-[2px] bg-red-400"></span>
				Stop
			</ToolbarButton>
		{:else}
			<ToolbarButton variant="primary" onclick={run}>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4.5 3.2l7.3 4.8-7.3 4.8V3.2z" fill="currentColor" /></svg>
				Run
				<span class="ml-0.5 text-[11px] opacity-60">⌘↵</span>
			</ToolbarButton>
		{/if}
	{/snippet}
</PageHeader>

<!-- Single mode only. Four figures cannot describe several runs at once,
     so in compare mode each column carries its own in its footer. -->
{#if mode === 'single'}
	<StatGrid>
		<StatCard label="Latency" value={fmtLatency(single.elapsedMs)} />
		<StatCard
			label="First token"
			value={fmtLatency(single.firstTokenMs)}
			hint={stream ? undefined : 'stream only'}
		/>
		<StatCard
			label="Tokens"
			value={fmtTokens(usage?.total_tokens ?? null)}
			hint={usage ? `${usage.prompt_tokens} in · ${usage.completion_tokens} out` : undefined}
		/>
		<StatCard label="Throughput" value={fmtThroughput(usage?.completion_tokens ?? null, single.elapsedMs)} />
	</StatGrid>
{/if}

<!-- items-start so the settings rail keeps its own height instead of being
     stretched to match a long conversation beside it. -->
<div class="grid grid-cols-[minmax(0,1fr)_324px] items-start gap-3.5">
	<div class="flex min-w-0 flex-col gap-3.5">
		<Panel title="Messages">
			{#snippet actions()}
				<span class="text-[11.5px] text-zinc-600">
					{drafts.length}
					{drafts.length === 1 ? 'message' : 'messages'}
				</span>
			{/snippet}

			<div class="flex flex-col gap-2 p-3.5">
				{#each drafts as _draft, index (index)}
					<MessageEditor
						bind:message={drafts[index]}
						disabled={running}
						onremove={drafts.length > 1 ? () => (drafts = drafts.filter((_, i) => i !== index)) : undefined}
					/>
				{/each}

				<button
					type="button"
					class="flex h-9 w-fit items-center gap-[7px] rounded-lg border border-dashed border-line-strong px-3 text-[12.5px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-50"
					disabled={running}
					onclick={addMessage}
				>
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
					Add message
				</button>
			</div>
		</Panel>

		<!--
			One shape for both modes. A single run is a comparison of one, and giving
			it its own markup is how the two drift - the credential would end up
			validated differently, or the metrics shown in one and not the other.

			360px rather than 300px: this row now carries a credential field beside
			the view controls, and three of them do not share 300px legibly.
		-->
		<div
			class={mode === 'single' ? '' : 'grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] items-start gap-3.5'}
		>
			{#each runs as entry, index (index)}
				{@const answered = responseTurns(toResponsePayload(entry.assembly))}
				<ResponsePanel
					turns={answered}
					json={entry.wire}
					running={entry.running}
					error={entry.error}
					finishReason={entry.assembly.finishReason}
					logId={entry.logId}
					elapsedMs={mode === 'single' ? null : entry.elapsedMs}
					tokens={mode === 'single' ? null : (entry.assembly.usage?.total_tokens ?? null)}
				>
					{#snippet header()}
						<div class="flex min-w-0 flex-1 items-center gap-2">
							<div class="min-w-0 flex-1">
								<ModelPicker
									id="playground-model-{index}"
									bind:value={entry.model}
									disabled={running}
									class={FIELD_CLASS}
								/>
							</div>
							{#if mode === 'compare'}
								<button
									type="button"
									class="size-9 flex-none rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-40"
									aria-label="Remove this model"
									disabled={running || comparisons.length <= 1}
									onclick={() => removeComparison(index)}
								>
									<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="mx-auto"><path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
								</button>
							{/if}
						</div>
					{/snippet}

					{#snippet controls()}
						<!-- Always masked. A reveal toggle costs width this row does not
						     have, and a pasted key is not something anyone reads back. -->
						<Input
							bind:value={entry.apiKey}
							type="password"
							placeholder="Provider API key"
							autocomplete="off"
							spellcheck={false}
							disabled={running}
							title="Sent as ai-api-key and spent upstream. Held in memory only."
							class={MONO_FIELD_CLASS}
						/>
					{/snippet}
				</ResponsePanel>
			{/each}

			{#if mode === 'compare' && comparisons.length < MAX_COMPARISONS}
				<!-- A tile in the grid rather than a button beneath it: adding a model
				     adds a column, and the control that does it should occupy the space
				     the column will take. -->
				<button
					type="button"
					class="flex min-h-[120px] w-full items-center justify-center gap-[7px] rounded-[9px] border border-dashed border-line-strong text-[12.5px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-40"
					disabled={running}
					onclick={addComparison}
				>
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
					Add model
				</button>
			{/if}
		</div>
	</div>

	<!-- Sticky, and scrolling inside itself rather than with the page. The
	     settings were previously only reachable by scrolling the conversation
	     out of view, which is the wrong thing to lose while changing them.
	     The offset covers the 57px topbar plus main's own top padding.

	     [&>*]:shrink-0 is load-bearing: these are flex children of a capped
	     column, so without it they shrink to fit instead of overflowing, and
	     Panel's own overflow-hidden then clips the text inside them. -->
	<div
		class="sticky top-0 flex max-h-[calc(100vh-108px)] flex-col gap-3.5 overflow-y-auto pr-0.5 [&>*]:shrink-0"
	>
		<Panel title="Webhook">
			<div class="flex flex-col gap-[18px] p-3.5">
				<div>
					<Select.Root
						type="single"
						value={webhookId}
						onValueChange={(next) => (webhookId = next)}
						disabled={running}
					>
						<Select.Trigger
							class="h-9 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-3 dark:hover:bg-surface-4"
						>
							{webhookId === NO_WEBHOOK ? 'None' : (webhooks.byId.get(webhookId)?.name ?? webhookId)}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value={NO_WEBHOOK} label="None" />
							{#each webhooks.endpoints.rows as webhook (webhook.id)}
								<Select.Item value={webhook.id} label={webhook.name} />
							{/each}
						</Select.Content>
					</Select.Root>

					<p class="mt-[7px] text-[11.5px] leading-normal text-zinc-600">
						Queues one delivery for this request's log. Cannot be combined with skipping the log, since a
						delivery needs a log to point at.
					</p>
				</div>
			</div>
		</Panel>

		<Panel title="Prompt">
			<PromptPicker bind:selection={promptSelection} disabled={running} />
		</Panel>


		<Panel title="Parameters">
			<div class="flex flex-col gap-[18px] p-3.5">
				<label class="flex items-center justify-between gap-3">
					<span class="flex flex-col gap-[3px]">
						<span class="text-[12.5px] font-medium text-zinc-200">Stream</span>
						<span class="text-[11.5px] text-zinc-600">Render tokens as they arrive</span>
					</span>
					<Switch
						checked={stream}
						disabled={running}
						onCheckedChange={(on) => (stream = on)}
						class="h-5 w-9 flex-none data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
					/>
				</label>

				<!-- Every field below is optional and blank by default. A playground
				     that pre-fills temperature with 1 quietly sends one on every
				     request, which is not the same as letting the provider choose. -->
				<div class="grid grid-cols-2 gap-3">
					<div>
						<Label for="playground-temperature" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
							Temperature
						</Label>
						<Input
							id="playground-temperature"
							bind:value={temperature}
							type="number"
							min="0"
							max="2"
							step="0.1"
							placeholder="Provider default"
							disabled={running}
							class={FIELD_CLASS}
						/>
					</div>
					<div>
						<Label for="playground-top-p" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
							Top P
						</Label>
						<Input
							id="playground-top-p"
							bind:value={topP}
							type="number"
							min="0"
							max="1"
							step="0.05"
							placeholder="Provider default"
							disabled={running}
							class={FIELD_CLASS}
						/>
					</div>
				</div>

				<div>
					<Label for="playground-max-tokens" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
						Max completion tokens
					</Label>
					<Input
						id="playground-max-tokens"
						bind:value={maxTokens}
						type="number"
						min="1"
						step="1"
						placeholder="Provider default"
						disabled={running}
						class={FIELD_CLASS}
					/>
				</div>

			</div>
		</Panel>
	</div>
</div>
