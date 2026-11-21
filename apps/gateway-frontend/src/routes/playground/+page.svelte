<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import type { ChatCompletionRequest, GatewayHeaders } from '#lib/api/chat-completions.ts';
import { getLogRequest } from '#lib/api/logs.ts';
import { FIELD_BASE } from '#lib/components/app/field.ts';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import ExamplePicker from '#lib/components/playground/example-picker.svelte';
import JsonEditor from '#lib/components/playground/json-editor.svelte';
import MessageEditor from '#lib/components/playground/message-editor.svelte';
import ModelPicker from '#lib/components/playground/model-picker.svelte';
import PlaygroundTabs from '#lib/components/playground/playground-tabs.svelte';
import type { PromptSelection } from '#lib/components/playground/prompt-picker.svelte';
import PromptPicker from '#lib/components/playground/prompt-picker.svelte';
import ResponsePanel from '#lib/components/playground/response-panel.svelte';
import { Input } from '#lib/components/ui/input/index.ts';
import { Label } from '#lib/components/ui/label/index.ts';
import * as Select from '#lib/components/ui/select/index.ts';
import { Switch } from '#lib/components/ui/switch/index.ts';
import { toResponsePayload } from '#lib/data/completion.ts';
import { responseTurns } from '#lib/data/conversation.ts';
import { CHAT_EXAMPLES } from '#lib/data/playground-examples.ts';
import {
  blankDrafts,
  type DraftMessage,
  draftsFrom,
  emptyDraft,
  fieldsOutsideForm,
  formJson,
  parseJsonObject,
  samplingError,
  toMessages,
} from '#lib/data/playground-request.ts';
import { PlaygroundRun } from '#lib/state/playground-run.svelte.ts';
import { webhooks } from '#lib/state/webhooks.svelte.ts';
import { page } from '$app/state';

// The one field style this page uses, matching the create-key dialog's.
const FIELD_CLASS = `h-9 px-[11px] text-[12.5px] ${FIELD_BASE}`;

const MONO_FIELD_CLASS = `${FIELD_CLASS} font-mono`;

// Each column sends the same request with its own model and provider
// credential.
const MAX_COMPARISONS = 4;

const NO_WEBHOOK = '__none__';

// The request body can be edited as a form or as raw JSON. Model, prompt,
// streaming and caching stay in their own controls either way.
const MODE_TABS = [
  { id: 'form' as const, label: 'Form' },
  { id: 'json' as const, label: 'JSON' },
];

// The request. Blank messages are dropped on send, so the system row costs
// nothing if it goes unused.
let drafts: DraftMessage[] = $state(blankDrafts());
let mode: 'form' | 'json' = $state('form');
let requestJson = $state('');

let comparisons = $state([new PlaygroundRun('openai/gpt-5')]);
const running = $derived(comparisons.some((run) => run.running));

let stream = $state(true);
let cacheEnabled = $state(false);

// The stored prompt to expand, or null to send the messages as written.
let promptSelection: PromptSelection | null = $state(null);

// The webhook to notify about this request, through ai-webhook-id. It queues
// one delivery for the log this request writes. Nothing fans out automatically
// yet, so naming one here is the only way to put work in the outbox.
let webhookId = $state(NO_WEBHOOK);

// A cleared numeric field is undefined, so that the provider's default stays
// unset.
let temperature = $state<number | undefined>(undefined);
let maxTokens = $state<number | undefined>(undefined);
let topP = $state<number | undefined>(undefined);
const sampling = $derived({ temperature: temperature, topP: topP, maxTokens: maxTokens });

onDestroy(stop);

onMount(() => {
  webhooks.endpoints.ensureLoaded();

  // The logs page links here with ?from=<log id> to replay a stored request.
  const from = page.url.searchParams.get('from');
  if (from) {
    void loadFromLog(from);
  }
});

/**
 * The chosen stored prompt as a request field.
 */
function promptField(): Pick<ChatCompletionRequest, 'prompt'> {
  if (!promptSelection) {
    return {};
  }

  // A reference and not the rendered text. The gateway expands it with the
  // same code path any other caller would get, built-ins included.
  return {
    prompt: {
      name: promptSelection.name,
      version: promptSelection.version,
      variables: promptSelection.variables,
    },
  };
}

/**
 * The form as a request body, or null after telling the reader why it cannot
 * be sent.
 */
function formBody(): ChatCompletionRequest | null {
  const messages = toMessages(drafts);
  const problem = samplingError(sampling) ?? (messages.length === 0 ? 'Write at least one message.' : null);

  if (problem) {
    toast.error(problem);

    return null;
  }

  return {
    // Replaced by every run with its own model. That substitution is what
    // makes compare mode the same request to several models by construction.
    model: '',
    messages: messages,
    ...promptField(),
    temperature: temperature,
    max_completion_tokens: maxTokens,
    top_p: topP,
  };
}

/**
 * The request JSON as an object, or null after telling the reader it is not
 * one.
 */
function parseRequestJson(): Record<string, unknown> | null {
  const parsed = parseJsonObject(requestJson);

  if (!parsed) {
    toast.error('The request JSON must be a valid object.');
  }

  return parsed;
}

/**
 * The JSON body as sent. The gateway validates it, and its 400 says what is
 * wrong.
 */
function jsonBody(): ChatCompletionRequest | null {
  const parsed = parseRequestJson();

  return parsed ? ({ ...parsed, model: '', ...promptField() } as ChatCompletionRequest) : null;
}

function buildHeaders(): GatewayHeaders {
  return {
    // Replaced by every run with its own credential, the same way the model is.
    'ai-api-key': '',
    'ai-cache-enabled': String(cacheEnabled),
    ...(webhookId !== NO_WEBHOOK ? { 'ai-webhook-id': webhookId } : {}),
  };
}

async function run(): Promise<void> {
  if (running) {
    return;
  }

  const targets = comparisons.filter((entry) => entry.model.trim().length > 0);
  if (targets.length === 0) {
    toast.error('Name at least one model to send this to.');

    return;
  }

  // Checked per column, because each spends its own credential. The models are
  // named, since with four columns "a key is missing" does not say which one.
  const unkeyed = targets.filter((entry) => entry.apiKey.trim().length === 0);
  if (unkeyed.length > 0) {
    toast.error(`Paste the provider API key for ${unkeyed.map((entry) => entry.model.trim()).join(', ')}.`);

    return;
  }

  const body = mode === 'json' ? jsonBody() : formBody();
  if (!body) {
    return;
  }

  const headers = buildHeaders();

  // In flight together, because the point of comparing is to see the answers
  // arrive against each other. PlaygroundRun.send never throws, so one provider
  // refusing a key cannot cancel the rest.
  await Promise.all(targets.map((entry) => entry.send(headers, body, stream)));
}

function stop(): void {
  for (const entry of comparisons) {
    entry.stop();
  }
}

function addComparison(): void {
  if (comparisons.length < MAX_COMPARISONS) {
    comparisons.push(new PlaygroundRun(''));
  }
}

function removeComparison(index: number): void {
  comparisons = comparisons.filter((_, position) => position !== index);
}

/**
 * Loads a stored request off a log, for running it again against another
 * model.
 *
 * @param id
 * The log to read the request from.
 */
async function loadFromLog(id: string): Promise<void> {
  // The stored payload is what the gateway sent. A request that named a prompt
  // was expanded into a system message before it was logged, so replaying it
  // reproduces the wording of the time and not the active prompt version.
  try {
    const payload = (await getLogRequest(id)) as Partial<ChatCompletionRequest> | null;

    if (!payload?.messages?.length) {
      toast.error('That log has no stored request to replay.');

      return;
    }

    applyRequest(payload);

    // The first column is seeded and the others are left alone. The original
    // model is the baseline a candidate is compared against.
    if (payload.model && comparisons[0]) {
      comparisons[0].model = payload.model;
    }

    toast.success('Loaded the request from that log');
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : 'Could not read that log.');
  }
}

/**
 * Fills the form from a request body. Fields the form has no place for are
 * ignored.
 */
function applyRequest(payload: Partial<ChatCompletionRequest>): void {
  drafts = draftsFrom(payload.messages ?? []);
  temperature = payload.temperature ?? undefined;
  maxTokens = payload.max_completion_tokens ?? undefined;
  topP = payload.top_p ?? undefined;
}

function setMode(next: 'form' | 'json'): void {
  if (next === mode) {
    return;
  }

  if (next === 'json') {
    requestJson = formJson(drafts, sampling);
    mode = 'json';

    return;
  }

  const parsed = parseRequestJson();
  if (!parsed) {
    return;
  }

  applyRequest(parsed as Partial<ChatCompletionRequest>);

  const dropped = fieldsOutsideForm(parsed);
  if (dropped.length > 0) {
    toast.warning(`The form has no fields for ${dropped.join(', ')}, so they were dropped.`);
  }

  mode = 'form';
}

/**
 * Replaces the messages, keeping the JSON view in step when it is the one
 * showing.
 */
function setDrafts(next: DraftMessage[]): void {
  drafts = next;

  if (mode === 'json') {
    requestJson = formJson(drafts, sampling);
  }
}

function applyExample(index: number): void {
  const example = CHAT_EXAMPLES[index];

  if (example) {
    setDrafts(example.messages.map((message) => ({ ...message })));
  }
}

function clear(): void {
  if (running) {
    return;
  }

  setDrafts(blankDrafts());

  for (const entry of comparisons) {
    entry.reset();
  }
}

function addMessage(): void {
  // Alternating, because the reason to add a message under a user turn is
  // almost always to write the assistant's half of a few-shot example.
  drafts.push(emptyDraft(drafts.at(-1)?.role === 'user' ? 'assistant' : 'user'));
}

function onKeydown(event: KeyboardEvent): void {
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
		<PlaygroundTabs current="chat" />
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

<!-- items-start so the settings rail keeps its own height instead of being
     stretched to match a long conversation beside it. -->
<div class="grid grid-cols-[minmax(0,1fr)_324px] items-start gap-3.5">
	<div class="flex min-w-0 flex-col gap-3.5">
		<Panel title={mode === 'json' ? 'Request' : 'Messages'}>
			{#snippet actions()}
				{#if mode === 'form'}
					<span class="text-[11.5px] text-zinc-600">
						{drafts.length}
						{drafts.length === 1 ? 'message' : 'messages'}
					</span>
				{/if}
				<ExamplePicker examples={CHAT_EXAMPLES} onpick={applyExample} disabled={running} />
				<FilterTabs tabs={MODE_TABS} bind:value={() => mode, setMode} />
			{/snippet}

			{#if mode === 'json'}
				<div class="p-3.5">
					<JsonEditor bind:value={requestJson} label="Request JSON" disabled={running} />
				</div>
			{:else}
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
			{/if}
		</Panel>

		<div class="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] items-start gap-3.5">
			{#each comparisons as entry, index (entry)}
				{@const answered = responseTurns(toResponsePayload(entry.assembly))}
				<ResponsePanel
					turns={answered}
					json={entry.wire}
					running={entry.running}
					error={entry.error}
					finishReason={entry.assembly.finishReason}
					traceId={entry.traceId}
					elapsedMs={entry.elapsedMs}
					tokens={entry.assembly.usage?.total_tokens ?? null}
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
							<button
								type="button"
								class="size-9 flex-none rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-40"
								aria-label="Remove this model"
								disabled={running || comparisons.length <= 1}
								onclick={() => removeComparison(index)}
							>
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="mx-auto"><path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
							</button>
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

			{#if comparisons.length < MAX_COMPARISONS}
				<!-- A tile in the grid and not a button beneath it. Adding a model adds
				     a column, and the control that does it sits where the column will
				     go. -->
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

	     The shrink-0 on the children is needed. They are flex children of a
	     capped column, so without it they shrink to fit instead of overflowing,
	     and Panel's own overflow-hidden then clips the text inside them. -->
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

				<label class="flex items-center justify-between gap-3">
					<span class="flex flex-col gap-[3px]">
						<span class="text-[12.5px] font-medium text-zinc-200">Enable caching</span>
						<span class="text-[11.5px] text-zinc-600">Reuse matching responses for 5 minutes</span>
					</span>
					<Switch
						aria-label="Enable caching"
						checked={cacheEnabled}
						disabled={running}
						onCheckedChange={(on) => (cacheEnabled = on)}
						class="h-5 w-9 flex-none data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
					/>
				</label>

				{#if mode === 'json'}
					<p class="text-[11.5px] leading-normal text-zinc-600">
						Temperature, top P and max tokens come from the request JSON while you edit it.
					</p>
				{/if}

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
							bind:value={() => temperature, (value) => (temperature = value ?? undefined)}
							type="number"
							min="0"
							max="2"
							step="0.1"
							placeholder="Provider default"
							disabled={running || mode === 'json'}
							class={FIELD_CLASS}
						/>
					</div>
					<div>
						<Label for="playground-top-p" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
							Top P
						</Label>
						<Input
							id="playground-top-p"
							bind:value={() => topP, (value) => (topP = value ?? undefined)}
							type="number"
							min="0"
							max="1"
							step="0.05"
							placeholder="Provider default"
							disabled={running || mode === 'json'}
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
						bind:value={() => maxTokens, (value) => (maxTokens = value ?? undefined)}
						type="number"
						min="1"
						step="1"
						placeholder="Provider default"
						disabled={running || mode === 'json'}
						class={FIELD_CLASS}
					/>
				</div>

			</div>
		</Panel>
	</div>
</div>
