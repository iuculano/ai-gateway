<script lang="ts">
import { getPromptVersion, renderPromptVersion } from '#lib/api/prompts.ts';
import { copyToClipboard } from '#lib/clipboard.ts';
import { FIELD_BASE } from '#lib/components/app/field.ts';
import Panel from '#lib/components/app/panel.svelte';
import * as Dialog from '#lib/components/ui/dialog/index.ts';
import { Input } from '#lib/components/ui/input/index.ts';
import { carryValues, extractVariables, segmentTemplate, suppliedVariables } from '#lib/data/prompts.ts';
import { prompts } from '#lib/state/prompts.svelte.ts';

// Renders a version with values the user types, and shows the result.
//
// The rendering is done by the API and not here. What comes back is the text
// the gateway would put in front of a model, with the same built-ins, the same
// precedence between them and what was supplied, and the same treatment of a
// tag nothing fills. A renderer in the page would be a second opinion, and the
// point of a preview is that it is not one.

interface Props {
  open?: boolean;
  promptId: string;
  promptName: string;

  /**
   * The version the dialog opens on, which falls back to the newest.
   */
  activeVersion?: number | null;
}

let { open = $bindable(false), promptId, promptName, activeVersion = null }: Props = $props();

// How long to wait before rendering again, so that a held key is one request
// and not ten.
const RENDER_DELAY_MS = 250;

let selected: number | null = $state(null);
let template = $state('');
let loadingTemplate = $state(false);

// What was typed for each of the template's own tags, by tag name.
let inputs: Record<string, string> = $state({});

let rendered: string | null = $state(null);
let unresolved: string[] = $state([]);
let rendering = $state(false);
let renderError: string | null = $state(null);

const versions = $derived(prompts.versionsFor(promptId));
const variables = $derived(extractVariables(template));
const segments = $derived(segmentTemplate(template));
const filled = $derived(variables.inputs.filter((name) => (inputs[name] ?? '').length > 0).length);

// Loads the versions and picks one. It runs on opening, and again when the
// dialog is reopened on a different prompt.
$effect(() => {
  if (!open) {
    return;
  }

  const id = promptId;
  const preferred = activeVersion;

  selected = null;
  template = '';
  rendered = null;
  unresolved = [];
  renderError = null;
  inputs = {};

  void prompts.ensureVersions(id).then(() => {
    const rows = prompts.versionsFor(id).rows;

    // The active version is what a caller gets by default, so it is what a
    // preview opens on. The newest is used only when nothing is active yet.
    const hasPreferred = preferred !== null && rows.some((row) => row.version === preferred);

    selected = hasPreferred ? preferred : (rows[0]?.version ?? null);
  });
});

// Fetches the chosen version's text.
$effect(() => {
  if (!open || selected === null) {
    return;
  }

  loadingTemplate = true;

  getPromptVersion(promptId, selected)
    .then((loaded) => {
      template = loaded.prompt;

      // Switching version keeps what was typed for the tags the new template
      // still has.
      inputs = carryValues(extractVariables(loaded.prompt).inputs, inputs);
    })
    .catch((error: unknown) => {
      renderError = error instanceof Error ? error.message : 'Failed to load the version.';
    })
    .finally(() => {
      loadingTemplate = false;
    });
});

async function render(id: string, version: number, payload: Record<string, string>): Promise<void> {
  rendering = true;
  renderError = null;

  try {
    const result = await renderPromptVersion(id, version, payload);

    rendered = result.prompt;
    unresolved = result.unresolved;
  } catch (error) {
    renderError = error instanceof Error ? error.message : 'Failed to render the prompt.';
  } finally {
    rendering = false;
  }
}

// Renders again whenever the version or a value changes, after a pause. The
// request is made from a timeout, so nothing it writes is tracked back in here.
$effect(() => {
  if (!open || selected === null || loadingTemplate || !template) {
    return;
  }

  const id = promptId;
  const version = selected;

  // An empty box is left out and not sent as an empty string. The renderer
  // takes an empty string as a real value and puts nothing in its place, which
  // looks the same as a tag that resolved. Left out, the tag comes back as
  // unresolved and stays in the output, which is what not filled in yet should
  // look like.
  const payload = suppliedVariables(variables.inputs, $state.snapshot(inputs));

  const timer = setTimeout(() => {
    void render(id, version, payload);
  }, RENDER_DELAY_MS);

  return () => clearTimeout(timer);
});

function copyRendered(): void {
  if (rendered !== null) {
    void copyToClipboard(rendered, 'Rendered prompt copied');
  }
}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex h-[calc(100dvh-4rem)] w-[980px] flex-col gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[980px]"
		showCloseButton={false}
	>
		<div class="flex-none border-b border-line px-6 pt-[22px] pb-[18px]">
			<Dialog.Title class="mb-[5px] text-[17px] font-semibold tracking-[-0.01em]">
				Preview <code class="font-mono text-[15px] text-zinc-400">{promptName}</code>
			</Dialog.Title>
			<Dialog.Description class="text-[13px] text-zinc-500">
				Rendered by the API, so this is the text the gateway would send.
			</Dialog.Description>
		</div>

		{#if versions.loading && versions.rows.length === 0}
			<div class="flex grow items-center justify-center text-[13px] text-zinc-600">Loading versions…</div>
		{:else if versions.rows.length === 0}
			<div class="flex grow flex-col items-center justify-center gap-1.5 px-6 text-center">
				<span class="text-[14px] font-medium text-zinc-300">No versions yet</span>
				<span class="text-[12.5px] text-zinc-600">Add a version to this prompt and there will be something to render.</span>
			</div>
		{:else}
			<!-- The version picker, as chips and not a select. The count is small, the
			     active one has to look different, and switching is the main thing
			     done in this dialog. -->
			<div class="flex flex-none items-center gap-2 overflow-x-auto border-b border-line bg-surface-1 px-6 py-3">
				<span class="flex-none text-[11.5px] tracking-[.06em] text-zinc-600 uppercase">Version</span>

				{#each versions.rows as row (row.id)}
					{@const isSelected = selected === row.version}
					{@const isActive = activeVersion === row.version}
					<button
						type="button"
						class="flex-none rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors {isSelected
							? 'border-emerald-500/40 bg-emerald-500/12 text-emerald-400'
							: 'border-line-strong bg-surface-3 text-zinc-400 hover:bg-surface-4 hover:text-zinc-200'}"
						onclick={() => (selected = row.version)}
					>
						v{row.version}{isActive ? ' · active' : ''}
					</button>
				{/each}
			</div>

			<div class="grid min-h-0 grow grid-cols-2 divide-x divide-line">
				<!-- On the left, what is being rendered and the values going into it. -->
				<div class="flex min-h-0 flex-col gap-3.5 overflow-y-auto p-5">
					<Panel title="Template · v{selected ?? '—'}">
						{#if loadingTemplate}
							<div class="px-3.5 py-[13px] text-[12.5px] text-zinc-600">Loading…</div>
						{:else}
							<pre class="max-h-[220px] overflow-auto px-3.5 py-[13px] font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-zinc-300">{#each segments as segment, index (index)}{#if segment.variable}<span
											class="rounded-[4px] bg-emerald-500/12 px-[3px] text-emerald-400">{segment.text}</span>{:else}{segment.text}{/if}{/each}</pre>
						{/if}
					</Panel>

					<Panel title="Inputs">
						{#snippet actions()}
							<span class="text-[11.5px] text-zinc-600">
								{filled} of {variables.inputs.length} filled
							</span>
						{/snippet}

						{#if variables.inputs.length === 0}
							<div class="px-3.5 py-[13px] text-[12.5px] leading-normal text-zinc-600">
								This template takes no inputs. Anything it substitutes is filled in by the server.
							</div>
						{:else}
							<div class="flex flex-col gap-3 px-3.5 py-[13px]">
								{#each variables.inputs as name (name)}
									<div>
										<label
											for="preview-input-{name}"
											class="mb-[6px] block font-mono text-[11.5px] text-zinc-400"
										>
											{name}
										</label>
										<Input
											id="preview-input-{name}"
											bind:value={inputs[name]}
											placeholder="value"
											class="h-9 px-[11px] font-mono text-[12.5px] {FIELD_BASE}"
										/>
									</div>
								{/each}
							</div>
						{/if}
					</Panel>

					{#if variables.builtins.length > 0}
						<Panel title="Filled in for you">
							<div class="flex flex-col">
								{#each variables.builtins as name, index (name)}
									<div
										class="flex items-baseline gap-3 px-3.5 py-2.5 {index > 0 ? 'border-t border-line' : ''}"
									>
										<code class="flex-none font-mono text-[11.5px] text-sky-300">{name}</code>
									</div>
								{/each}
							</div>
						</Panel>
					{/if}
				</div>

				<!-- On the right, the result. -->
				<div class="flex min-h-0 flex-col bg-surface-1">
					<div class="flex flex-none items-center gap-2.5 border-b border-line px-5 py-3">
						<span class="text-[11.5px] tracking-[.06em] text-zinc-600 uppercase">Rendered</span>

						{#if rendering}
							<span class="text-[11.5px] text-zinc-600">rendering…</span>
						{/if}

						{#if unresolved.length > 0}
							<span
								class="rounded-[5px] bg-amber-500/12 px-1.5 py-px text-[10.5px] font-medium text-amber-500"
								title={unresolved.join(', ')}
							>
								{unresolved.length} unresolved
							</span>
						{/if}

						<button
							type="button"
							class="ml-auto h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-medium text-zinc-400 hover:bg-surface-4 hover:text-zinc-200 disabled:opacity-50"
							disabled={rendered === null}
							onclick={copyRendered}
						>
							Copy
						</button>
					</div>

					{#if renderError}
						<div class="flex grow flex-col items-center justify-center gap-2.5 px-6 text-center">
							<span class="text-[13px] text-red-400">{renderError}</span>
						</div>
					{:else if rendered === null}
						<div class="flex grow items-center justify-center text-[12.5px] text-zinc-600">
							{loadingTemplate ? 'Loading…' : 'Nothing rendered yet.'}
						</div>
					{:else}
						<pre class="min-h-0 grow overflow-auto px-5 py-[18px] font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-zinc-200 select-all">{rendered}</pre>
					{/if}

					{#if unresolved.length > 0}
						<!-- Named and not only counted. An unresolved tag is left in the
						     output as it is, so without this the only clue is spotting the
						     braces that survived. -->
						<div class="flex-none border-t border-line bg-surface-2 px-5 py-3">
							<div class="mb-1.5 text-[11.5px] text-amber-400">
								Left unfilled, and returned as written:
							</div>
							<div class="flex flex-wrap gap-1.5">
								{#each unresolved as name (name)}
									<code class="rounded-[5px] border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-300">
										{name}
									</code>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="flex flex-none gap-2.5 border-t border-line bg-surface-1 px-6 py-4">
			<button
				type="button"
				class="ml-auto h-[38px] rounded-lg border border-line-strong bg-surface-3 px-4 text-[13.5px] font-medium text-zinc-200 hover:bg-surface-4"
				onclick={() => (open = false)}
			>
				Close
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
