<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { toast } from 'svelte-sonner';
import { page } from '$app/state';
import { createDecision, type Decision, type DecisionQuestion, type DecisionRequest } from '$lib/api/decisions';
import { getLogRequest } from '$lib/api/logs';
import { copyToClipboard } from '$lib/clipboard';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import JsonView from '$lib/components/logs/json-view.svelte';
import DecisionAnswers from '$lib/components/playground/decision-answers.svelte';
import ExamplePicker from '$lib/components/playground/example-picker.svelte';
import JsonEditor from '$lib/components/playground/json-editor.svelte';
import ModelPicker from '$lib/components/playground/model-picker.svelte';
import PlaygroundTabs from '$lib/components/playground/playground-tabs.svelte';
import QuestionEditor from '$lib/components/playground/question-editor.svelte';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Textarea } from '$lib/components/ui/textarea';
import { type DraftQuestion, emptyQuestion, toDraft, toQuestion } from '$lib/data/decision-questions';
import { fmtLatency, fmtTokens } from '$lib/data/format';
import { DECISION_EXAMPLES } from '$lib/data/playground-examples';

const FIELD_CLASS =
  'h-9 rounded-lg border-line-strong bg-surface-3 px-[11px] text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';

let model = $state('');
let apiKey = $state('');
let input = $state('');
let questions: DraftQuestion[] = $state([emptyQuestion()]);

let running = $state(false);
let error = $state<string | null>(null);
let decision = $state<Decision | null>(null);
let elapsedMs = $state<number | null>(null);
let controller: AbortController | null = null;

const VIEW_TABS = [
  { id: 'simple' as const, label: 'Simple' },
  { id: 'json' as const, label: 'JSON' },
];
let view: 'simple' | 'json' = $state('simple');
const json = $derived(decision ? JSON.stringify(decision, null, 2) : '');

onDestroy(stop);

onMount(() => {
  // The logs page links here with ?from=<log id> to replay a stored request.
  const from = page.url.searchParams.get('from');
  if (from) void loadFromLog(from);
});

async function loadFromLog(id: string) {
  try {
    const payload = (await getLogRequest(id)) as Partial<DecisionRequest> | null;

    if (!payload?.questions?.length) {
      toast.error('That log has no stored decision request to replay.');
      return;
    }

    input = payload.input ?? '';
    questions = payload.questions.map(toDraft);
    if (payload.model) model = payload.model;
    if (mode === 'json') requestJson = formToJson();

    toast.success('Loaded the request from that log');
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : 'Could not read that log.');
  }
}

// The request can be edited as a form or as raw JSON. The model stays in the
// picker either way and overrides any `model` written in the JSON.
const MODE_TABS = [
  { id: 'form' as const, label: 'Form' },
  { id: 'json' as const, label: 'JSON' },
];
let mode: 'form' | 'json' = $state('form');
let requestJson = $state('');

// The request fields the form can show. Anything else only survives in JSON.
const FORM_FIELDS = ['input', 'questions'];

function formToJson(): string {
  return JSON.stringify({ input: input, questions: questions.map(toQuestion) }, null, 2);
}

/** The JSON as an object, or null after telling the reader what's wrong. */
function parseRequestJson(): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(requestJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }

  toast.error('The request JSON must be a valid object.');
  return null;
}

function setMode(next: 'form' | 'json') {
  if (next === mode) return;

  if (next === 'json') {
    requestJson = formToJson();
    mode = 'json';
    return;
  }

  const parsed = parseRequestJson();
  if (!parsed) return;

  try {
    const nextQuestions = ((parsed.questions ?? []) as DecisionQuestion[]).map(toDraft);
    input = typeof parsed.input === 'string' ? parsed.input : '';
    questions = nextQuestions.length > 0 ? nextQuestions : [emptyQuestion()];
  } catch {
    toast.error("The questions in the JSON don't fit the form. Fix them or keep editing as JSON.");
    return;
  }

  const dropped = Object.keys(parsed).filter((key) => !FORM_FIELDS.includes(key) && key !== 'model');
  if (dropped.length > 0) {
    toast.warning(`The form has no fields for ${dropped.join(', ')}, so they were dropped.`);
  }

  mode = 'form';
}

function applyExample(index: number) {
  const example = DECISION_EXAMPLES[index];
  if (!example) return;

  input = example.input;
  questions = example.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
  }));

  if (mode === 'json') requestJson = formToJson();
}

/**
 * The request body, or null when the form is not ready to send.
 *
 * Checked here rather than left to the gateway's 400: its messages name schema
 * paths like questions[2].choices[0].description, and this can name the question.
 */
function buildBody(): DecisionRequest | null {
  if (input.trim().length === 0) {
    toast.error('Write the input the questions are about.');
    return null;
  }

  const names = new Set<string>();

  for (const [index, draft] of questions.entries()) {
    const name = draft.name.trim();
    const label = name || `Question ${index + 1}`;

    if (!name || !draft.instructions.trim()) {
      toast.error(`${label} needs a name and instructions.`);
      return null;
    }

    // The gateway accepts duplicates, but answers come back keyed by name, so
    // one would silently overwrite the other.
    if (names.has(name)) {
      toast.error(`Two questions are named ${name}.`);
      return null;
    }
    names.add(name);

    if (draft.type === 'predicate') continue;

    if (draft.options.some((option) => !option.value.trim() || !option.description.trim())) {
      toast.error(`Fill in every ${draft.type === 'choice' ? 'choice' : 'level'} of ${label}.`);
      return null;
    }

    const values = draft.options.map((option) => option.value.trim());
    if (draft.type === 'choice' && new Set(values).size !== values.length) {
      toast.error(`${label} has two choices with the same value.`);
      return null;
    }
  }

  return { model: model.trim(), input: input, questions: questions.map(toQuestion) };
}

async function run() {
  if (running) return;

  if (model.trim().length === 0) {
    toast.error('Name a model to send this to.');
    return;
  }

  if (apiKey.trim().length === 0) {
    toast.error('Paste the provider API key.');
    return;
  }

  let body: DecisionRequest | null;
  if (mode === 'json') {
    // Sent as written. The gateway validates it, and its 400 says what's wrong.
    const parsed = parseRequestJson();
    body = parsed ? ({ ...parsed, model: model.trim() } as DecisionRequest) : null;
  } else {
    body = buildBody();
  }
  if (!body) return;

  const current = new AbortController();
  controller = current;
  running = true;
  error = null;
  decision = null;
  elapsedMs = null;
  const startedAt = performance.now();

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

function stop() {
  controller?.abort();
}

function clear() {
  if (running) return;

  input = '';
  questions = [emptyQuestion()];
  if (mode === 'json') requestJson = formToJson();
  decision = null;
  error = null;
  elapsedMs = null;
}

function copy() {
  if (!json) {
    toast.error('Nothing to copy yet.');
    return;
  }

  void copyToClipboard(json, 'Response copied');
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
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
						class="max-h-80 min-h-[96px] rounded-lg border-line-strong bg-surface-3 px-[11px] py-2 text-[13px] leading-[1.6] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
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
							onremove={questions.length > 1 ? () => (questions = questions.filter((_, i) => i !== index)) : undefined}
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
