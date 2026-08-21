<script lang="ts">
import { toast } from 'svelte-sonner';
import { getPromptVersion, renderPromptVersion } from '$lib/api/prompts';
import Panel from '$lib/components/app/panel.svelte';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { BUILTINS, extractVariables, segmentTemplate } from '$lib/data/prompts';
import { prompts } from '$lib/state/prompts.svelte';

/**
 * Renders a version with values the user types, and shows the result.
 *
 * The rendering is done by the API, not here. What comes back is the text the
 * gateway would actually put in front of a model - built-ins resolved by the
 * same clock, the same precedence between built-ins and supplied inputs, the
 * same decision about what to do with a tag nothing fills. A local renderer
 * would be a second opinion, and the whole point of a preview is that it is
 * not one.
 */
let {
  open = $bindable(false),
  promptId,
  promptName,
  activeVersion = null,
}: {
  open?: boolean;
  promptId: string;
  promptName: string;
  /** Preselected when the dialog opens. Falls back to the newest version. */
  activeVersion?: number | null;
} = $props();

/** Debounce before re-rendering, so a held key is one request rather than ten. */
const RENDER_DELAY_MS = 250;

let selected: number | null = $state(null);
let template = $state('');
let loadingTemplate = $state(false);

/** Values for the non-built-in tags, keyed by tag name. */
let inputs: Record<string, string> = $state({});

let rendered: string | null = $state(null);
let unresolved: string[] = $state([]);
let rendering = $state(false);
let renderError: string | null = $state(null);

const versions = $derived(prompts.versionsFor(promptId));
const variables = $derived(extractVariables(template));
const segments = $derived(segmentTemplate(template));

// Load the version list and choose one. Runs on open, and again if the dialog
// is reopened on a different prompt.
$effect(() => {
  if (!open) return;

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
    if (rows.length === 0) return;

    // The active version is what a caller gets by default, so it is what a
    // preview should open on. Newest only when nothing is active yet.
    const wanted = preferred !== null && rows.some((row) => row.version === preferred) ? preferred : rows[0]?.version;

    selected = wanted ?? null;
  });
});

// Fetch the chosen version's text.
$effect(() => {
  if (!open || selected === null) return;

  const id = promptId;
  const version = selected;

  loadingTemplate = true;

  getPromptVersion(id, version)
    .then((loaded) => {
      template = loaded.prompt;

      // Seed a box per detected tag, keeping anything already typed - switching
      // version should not clear values the new template still asks for.
      const next: Record<string, string> = {};
      for (const name of extractVariables(loaded.prompt).inputs) {
        next[name] = inputs[name] ?? '';
      }

      inputs = next;
    })
    .catch((error: unknown) => {
      renderError = error instanceof Error ? error.message : 'Failed to load the version.';
    })
    .finally(() => {
      loadingTemplate = false;
    });
});

// Re-render whenever the version or any value changes, debounced. The request
// is fired from a timeout, so nothing it writes is tracked back into here.
$effect(() => {
  if (!open || selected === null || loadingTemplate || !template) return;

  const id = promptId;
  const version = selected;

  // Empty boxes are omitted rather than sent as ''. The renderer treats a
  // supplied empty string as a real value and substitutes nothing, which in a
  // preview is indistinguishable from a tag that resolved correctly. Left out,
  // the tag comes back in `unresolved` and stays visible in the output - which
  // is what "you have not filled this in yet" should look like.
  const payload = Object.fromEntries(Object.entries($state.snapshot(inputs)).filter(([, value]) => value.length > 0));

  const timer = setTimeout(() => {
    void render(id, version, payload);
  }, RENDER_DELAY_MS);

  return () => clearTimeout(timer);
});

async function render(id: string, version: number, payload: Record<string, string>) {
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

function copyRendered() {
  if (rendered === null) return;

  navigator.clipboard?.writeText(rendered).catch(() => {});
  toast.success('Rendered prompt copied');
}

const filled = $derived(variables.inputs.filter((name) => (inputs[name] ?? '').length > 0).length);
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
			<!-- Version picker. Chips rather than a select: the count is small, the
			     active one has to be visibly different, and switching is the main
			     thing done in this dialog. -->
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
				<!-- Left: what is being rendered, and the values going into it. -->
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
											class="h-9 rounded-lg border-line-strong bg-surface-3 px-[11px] font-mono text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
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
										<span class="text-[11.5px] text-zinc-600">{BUILTINS.get(name)?.description}</span>
									</div>
								{/each}
							</div>
						</Panel>
					{/if}

					{#if variables.unknownBuiltins.length > 0}
						<div class="rounded-[10px] border border-amber-500/25 bg-amber-500/8 px-3.5 py-3 text-[11.5px] leading-normal text-amber-300">
							<code class="font-mono">{variables.unknownBuiltins.join(', ')}</code>
							{variables.unknownBuiltins.length === 1 ? 'uses' : 'use'} the reserved
							<code class="font-mono">aig.</code> prefix but {variables.unknownBuiltins.length === 1 ? 'is' : 'are'}
							not a built-in, so {variables.unknownBuiltins.length === 1 ? 'it' : 'they'} cannot be supplied here
							either. Edit the template to fix the name.
						</div>
					{/if}
				</div>

				<!-- Right: the result. -->
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
						<!-- Named rather than merely counted: an unresolved tag is left in
						     the output verbatim, so without this the only clue is spotting
						     the braces that survived. -->
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
