<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import { createDecision, type Decision, type DecisionQuestion, type DecisionRequest } from '#lib/api/decisions.ts';
import { getLogRequest } from '#lib/api/logs.ts';
import { copyToClipboard } from '#lib/clipboard.ts';
import { FIELD_BASE } from '#lib/components/app/field.ts';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import PageHeader from '#lib/components/app/page-header.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import JsonView from '#lib/components/logs/json-view.svelte';
import DecisionAnswers from '#lib/components/playground/decision-answers.svelte';
import ExamplePicker from '#lib/components/playground/example-picker.svelte';
import JsonEditor from '#lib/components/playground/json-editor.svelte';
import ModelPicker from '#lib/components/playground/model-picker.svelte';
import PlaygroundTabs from '#lib/components/playground/playground-tabs.svelte';
import QuestionEditor from '#lib/components/playground/question-editor.svelte';
import { Input } from '#lib/components/ui/input/index.ts';
import { Label } from '#lib/components/ui/label/index.ts';
import { Textarea } from '#lib/components/ui/textarea/index.ts';
import {
  type DraftQuestion,
  decisionProblem,
  emptyQuestion,
  toDraft,
  toQuestion,
} from '#lib/data/decision-questions.ts';
import { fmtLatency, fmtTokens } from '#lib/data/format.ts';
import { DECISION_EXAMPLES } from '#lib/data/playground-examples.ts';
import { fieldsOutsideForm, parseJsonObject } from '#lib/data/playground-request.ts';
import { page } from '$app/state';

type Mode = 'form' | 'json';
type View = 'simple' | 'json';

const FIELD_CLASS = `h-9 px-[11px] text-[12.5px] ${FIELD_BASE}`;

// The request can be edited as a form or as raw JSON. The model stays in the
// picker either way, and overrides any `model` written in the JSON.
const MODE_TABS = [
  { id: 'form', label: 'Form' },
  { id: 'json', label: 'JSON' },
] satisfies { id: Mode; label: string }[];

const VIEW_TABS = [
  { id: 'simple', label: 'Simple' },
  { id: 'json', label: 'JSON' },
] satisfies { id: View; label: string }[];

// The request fields the form can show. Anything else only survives as JSON.
const FORM_FIELDS = ['input', 'questions'];

let model = $state('');
let apiKey = $state('');
let input = $state('');
let questions: DraftQuestion[] = $state([emptyQuestion()]);

let mode: Mode = $state('form');
let requestJson = $state('');

let running = $state(false);
let error = $state<string | null>(null);
let decision = $state<Decision | null>(null);
let elapsedMs = $state<number | null>(null);
let controller: AbortController | null = null;

let view: View = $state('simple');
const json = $derived(decision ? JSON.stringify(decision, null, 2) : '');

onDestroy(stop);

onMount(() => {
  // The logs page links here with ?from=<log id> to replay a stored request.
  const from = page.url.searchParams.get('from');

  if (from) {
    void loadFromLog(from);
  }
});

function formToJson(): string {
  return JSON.stringify({ input: input, questions: questions.map(toQuestion) }, null, 2);
}

/**
 * Rewrites the JSON from the form, when the JSON is what is on show and the
 * form has just been filled from somewhere else.
 */
function syncJson(): void {
  if (mode === 'json') {
    requestJson = formToJson();
  }
}

/**
 * Loads a stored request off a log, for running it again.
 */
async function loadFromLog(id: string): Promise<void> {
  try {
    const payload = (await getLogRequest(id)) as Partial<DecisionRequest> | null;

    if (!payload?.questions?.length) {
      toast.error('That log has no stored decision request to replay.');

      return;
    }

    input = payload.input ?? '';
    questions = payload.questions.map(toDraft);

    if (payload.model) {
      model = payload.model;
    }

    syncJson();
    toast.success('Loaded the request from that log');
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : 'Could not read that log.');
  }
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

function setMode(next: Mode): void {
  if (next === mode) {
    return;
  }

  if (next === 'json') {
    requestJson = formToJson();
    mode = 'json';

    return;
  }

  const parsed = parseRequestJson();

  if (!parsed) {
    return;
  }

  try {
    const drafts = ((parsed.questions ?? []) as DecisionQuestion[]).map(toDraft);

    input = typeof parsed.input === 'string' ? parsed.input : '';
    questions = drafts.length > 0 ? drafts : [emptyQuestion()];
  } catch {
    toast.error("The questions in the JSON don't fit the form. Fix them or keep editing as JSON.");

    return;
  }

  const dropped = fieldsOutsideForm(parsed, FORM_FIELDS);

  if (dropped.length > 0) {
    toast.warning(`The form has no fields for ${dropped.join(', ')}, so they were dropped.`);
  }

  mode = 'form';
}

function applyExample(index: number): void {
  const example = DECISION_EXAMPLES[index];

  if (!example) {
    return;
  }

  // Copied, so that editing a question does not edit the example it came from.
  input = example.input;
  questions = structuredClone(example.questions);
  syncJson();
}

/**
 * The form as a request body, or null after telling the reader why it cannot
 * be sent.
 */
function formRequest(): DecisionRequest | null {
  const problem = decisionProblem(input, questions);

  if (problem) {
    toast.error(problem);

    return null;
  }

  return { model: model.trim(), input: input, questions: questions.map(toQuestion) };
}

/**
 * The JSON as a request body, sent as written. The gateway checks it, and its
 * 400 says what is wrong.
 */
function jsonRequest(): DecisionRequest | null {
  const parsed = parseRequestJson();

  return parsed ? ({ ...parsed, model: model.trim() } as DecisionRequest) : null;
}

async function run(): Promise<void> {
  if (running) {
    return;
  }

  if (model.trim().length === 0) {
    toast.error('Name a model to send this to.');

    return;
  }

  if (apiKey.trim().length === 0) {
    toast.error('Paste the provider API key.');

    return;
  }

  const body = mode === 'json' ? jsonRequest() : formRequest();

  if (!body) {
    return;
  }

  const current = new AbortController();
  const startedAt = performance.now();

  controller = current;
  running = true;
  error = null;
  decision = null;
  elapsedMs = null;

  try {
    decision = await createDecision({ 'ai-api-key': apiKey.trim() }, body, current.signal);
    elapsedMs = performance.now() - startedAt;
  } catch (cause) {
    // Stopping is not failing.
    if (!current.signal.aborted) {
      error = cause instanceof Error ? cause.message : 'The request failed.';
    }
  } finally {
    running = false;
    controller = null;
  }
}

function stop(): void {
  controller?.abort();
}

function clear(): void {
  if (running) {
    return;
  }

  input = '';
  questions = [emptyQuestion()];
  decision = null;
  error = null;
  elapsedMs = null;
  syncJson();
}

function copy(): void {
  if (!json) {
    toast.error('Nothing to copy yet.');

    return;
  }

  void copyToClipboard(json, 'Response copied');
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void run();
  }
}
</script>

<svelte:window onkeydown={onKeydown} />

<PageHeader title="Playground" description="Ask a decision model typed questions about one input, and see how sure it is.">
	{#snippet actions()}
		<PlaygroundTabs current="decisions" />
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

<div class="flex flex-col gap-3.5">
	{#snippet requestControls()}
		<ExamplePicker examples={DECISION_EXAMPLES} onpick={applyExample} disabled={running} />
		<FilterTabs tabs={MODE_TABS} bind:value={() => mode, setMode} />
	{/snippet}

	{#snippet answers()}
		<Panel title="Answers">
			{#snippet actions()}
				<FilterTabs tabs={VIEW_TABS} bind:value={view} />
				<ToolbarButton onclick={copy}>Copy</ToolbarButton>
			{/snippet}

			{#if error}
				<div class="flex items-start gap-[9px] px-3.5 py-4 text-[12.5px] text-red-400">
					<svg width="15" height="15" viewBox="0 0 16 16" fill="none" class="mt-px flex-none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" /><path d="M8 5.2v3.4M8 10.8v.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
					<span class="break-words">{error}</span>
				</div>
			{:else if !decision}
				<div class="px-[13px] py-10 text-center text-[12.5px] text-zinc-600">
					{running ? 'Waiting for the model…' : 'Nothing sent yet. Run a request to see the answers here.'}
				</div>
			{:else if view === 'simple'}
				<DecisionAnswers answers={decision.answers} />
			{:else}
				<JsonView {json} highlight />
			{/if}

			{#if decision}
				<div class="flex flex-wrap items-center gap-3 border-t border-line px-3.5 py-2.5 text-[11.5px]">
					<span class="text-zinc-500 tabular-nums">{fmtLatency(elapsedMs)}</span>
					<span class="text-zinc-500 tabular-nums">{fmtTokens(decision.usage.total_tokens)} tok</span>
					<code class="ml-auto font-mono text-zinc-500">{decision.model}</code>
				</div>
			{/if}
		</Panel>
	{/snippet}

	<!-- What to ask about beside who answers it. -->
	<div class="grid grid-cols-[minmax(0,7fr)_minmax(0,3fr)] items-stretch gap-3.5">
		{#if mode === 'json'}
			<Panel title="Request" actions={requestControls}>
				<div class="p-3.5">
					<JsonEditor bind:value={requestJson} label="Request JSON" disabled={running} />
				</div>
			</Panel>
		{:else}
			<Panel title="Input" actions={requestControls}>
				<div class="p-3.5">
					<Textarea
						bind:value={input}
						placeholder="The text the questions are about."
						aria-label="Input"
						disabled={running}
						rows={4}
						class="max-h-80 min-h-[96px] px-[11px] py-2 text-[13px] leading-[1.6] {FIELD_BASE}"
					/>
				</div>
			</Panel>
		{/if}

		<Panel title="Model">
			<div class="flex flex-col gap-[18px] p-3.5">
				<div>
					<Label for="decision-model" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Model</Label>
					<ModelPicker id="decision-model" type="decision" bind:value={model} disabled={running} class={FIELD_CLASS} />
				</div>

				<div>
					<Label for="decision-api-key" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
						Provider API key
					</Label>
					<!-- Held in memory only, like the chat tab's. -->
					<Input
						id="decision-api-key"
						bind:value={apiKey}
						type="password"
						placeholder="Provider API key"
						autocomplete="off"
						spellcheck={false}
						disabled={running}
						class="{FIELD_CLASS} font-mono"
					/>
				</div>
			</div>
		</Panel>
	</div>

	{#if mode === 'json'}
		{@render answers()}
	{:else}
		<!-- Each question beside its answer. The answers stay in view while the
		     question list scrolls. -->
		<div class="grid grid-cols-[minmax(0,7fr)_minmax(0,3fr)] items-start gap-3.5">
			<Panel title="Questions">
				{#snippet actions()}
					<span class="text-[11.5px] text-zinc-600">
						{questions.length}
						{questions.length === 1 ? 'question' : 'questions'}
					</span>
				{/snippet}

				<div class="flex flex-col gap-2 p-3.5">
					{#each questions as _question, index (index)}
						<QuestionEditor
							bind:question={questions[index]}
							number={index + 1}
							disabled={running}
							onremove={questions.length > 1 ? () => (questions = questions.toSpliced(index, 1)) : undefined}
						/>
					{/each}

					<button
						type="button"
						class="flex h-9 w-fit items-center gap-[7px] rounded-lg border border-dashed border-line-strong px-3 text-[12.5px] text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 disabled:opacity-50"
						disabled={running}
						onclick={() => questions.push(emptyQuestion())}
					>
						<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
						Add question
					</button>
				</div>
			</Panel>

			<div class="sticky top-0 max-h-[calc(100vh-108px)] overflow-y-auto">
				{@render answers()}
			</div>
		</div>
	{/if}
</div>
