<script module lang="ts">
/** What the playground puts in the request body's `prompt` field. */
export interface PromptSelection {
  name: string;
  version: number;
  variables: Record<string, string>;
}
</script>

<script lang="ts">
import { onMount } from 'svelte';
import { getPromptVersion } from '$lib/api/prompts';
import type { Prompt } from '$lib/api/types';
import * as Select from '$lib/components/ui/select';
import { Input } from '$lib/components/ui/input';
import { BUILTINS, extractVariables } from '$lib/data/prompts';
import { prompts } from '$lib/state/prompts.svelte';

/**
 * Picks a stored prompt for the request, and collects its variables.
 *
 * The gateway expands the reference server-side, so nothing here renders
 * anything - the template is fetched only to work out which boxes to draw. What
 * the model actually receives is decided by the same code the API uses, which
 * is the point of sending a reference rather than the finished text.
 */
let {
  selection = $bindable(),
  disabled = false,
}: {
  /** null when the request should carry no prompt. */
  selection: PromptSelection | null;
  disabled?: boolean;
} = $props();

const NONE = '__none__';

let promptName = $state(NONE);
let version: number | null = $state(null);
let template = $state('');
let loading = $state(false);
let loadError: string | null = $state(null);
let values: Record<string, string> = $state({});

onMount(() => {
  prompts.ensureLoaded();
});

const selected = $derived<Prompt | undefined>(prompts.list.rows.find((prompt) => prompt.name === promptName));
const versions = $derived(selected ? prompts.versionsFor(selected.id) : null);
const variables = $derived(extractVariables(template));

// Load the chosen prompt's versions, and settle on one.
$effect(() => {
  const prompt = selected;
  if (!prompt) return;

  void prompts.ensureVersions(prompt.id).then(() => {
    const rows = prompts.versionsFor(prompt.id).rows;

    // The active version by default, because that is what a caller omitting
    // `version` would get from the API.
    version = prompt.active_version ?? rows[0]?.version ?? null;
  });
});

// Fetch the template for the chosen version, purely to discover its variables.
$effect(() => {
  const prompt = selected;
  const chosen = version;

  if (!prompt || chosen === null) {
    template = '';
    return;
  }

  loading = true;
  loadError = null;

  getPromptVersion(prompt.id, chosen)
    .then((loaded) => {
      template = loaded.prompt;

      // Keep anything already typed that the new template still asks for.
      const next: Record<string, string> = {};
      for (const name of extractVariables(loaded.prompt).inputs) {
        next[name] = values[name] ?? '';
      }

      values = next;
    })
    .catch((error: unknown) => {
      loadError = error instanceof Error ? error.message : 'Failed to load the version.';
      template = '';
    })
    .finally(() => {
      loading = false;
    });
});

// Publish upward. Only the variables the template actually asks for are sent -
// a stale value from a previously chosen prompt is not the caller's intent.
$effect(() => {
  if (!selected || version === null) {
    selection = null;
    return;
  }

  const supplied: Record<string, string> = {};
  for (const name of variables.inputs) {
    const value = values[name] ?? '';
    if (value.length > 0) {
      supplied[name] = value;
    }
  }

  selection = { name: selected.name, version: version, variables: supplied };
});

const missing = $derived(variables.inputs.filter((name) => (values[name] ?? '').length === 0));
</script>

<div class="flex flex-col gap-[18px] p-3.5">
	<div>
		<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Prompt</span>
		<Select.Root
			type="single"
			value={promptName}
			onValueChange={(next) => {
				promptName = next;
				version = null;
				values = {};
				template = '';
			}}
			{disabled}
		>
			<Select.Trigger
				class="h-9 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-3 dark:hover:bg-surface-4"
			>
				{promptName === NONE ? 'None' : promptName}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value={NONE} label="None" />
				{#each prompts.list.rows as prompt (prompt.id)}
					<!-- Referenced by name, the way the API resolves it. A prompt with
					     no version cannot be expanded, so it is offered but labelled. -->
					<Select.Item
						value={prompt.name}
						label={prompt.active_version == null ? `${prompt.name} (no version)` : prompt.name}
					/>
				{/each}
			</Select.Content>
		</Select.Root>

		<p class="mt-[7px] text-[11.5px] leading-normal text-zinc-600">
			Expanded by the gateway into a leading system message, ahead of the messages below.
		</p>
	</div>

	{#if selected}
		<div>
			<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Version</span>
			{#if versions?.loading && versions.rows.length === 0}
				<p class="text-[12px] text-zinc-600">Loading versions…</p>
			{:else if versions && versions.rows.length === 0}
				<p class="text-[12px] text-amber-400/90">
					This prompt has no versions, so the request would be refused.
				</p>
			{:else}
				<Select.Root
					type="single"
					value={version === null ? '' : String(version)}
					onValueChange={(next) => (version = Number(next))}
					{disabled}
				>
					<Select.Trigger
						class="h-9 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-3 dark:hover:bg-surface-4"
					>
						{version === null ? 'Choose' : `v${version}`}
					</Select.Trigger>
					<Select.Content>
						{#each versions?.rows ?? [] as row (row.id)}
							<Select.Item
								value={String(row.version)}
								label={selected.active_version === row.version ? `v${row.version} · active` : `v${row.version}`}
							/>
						{/each}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>

		{#if loadError}
			<p class="text-[12px] text-red-400">{loadError}</p>
		{:else if loading}
			<p class="text-[12px] text-zinc-600">Reading the template…</p>
		{:else if variables.inputs.length > 0}
			<div>
				<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Variables
					<!-- Named here rather than left to a 422 from the API: this page is
					     where the request is being assembled, so the gap is worth showing
					     before it is sent rather than after. -->
					{#if missing.length > 0}
						<span class="ml-1 font-normal text-amber-400/90">{missing.length} unfilled</span>
					{/if}
				</span>

				<div class="flex flex-col gap-2.5">
					{#each variables.inputs as name (name)}
						<div>
							<label for="playground-var-{name}" class="mb-[5px] block font-mono text-[11.5px] text-zinc-400">
								{name}
							</label>
							<Input
								id="playground-var-{name}"
								bind:value={values[name]}
								placeholder="value"
								{disabled}
								class="h-9 rounded-lg border-line-strong bg-surface-3 px-[11px] font-mono text-[12.5px] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
							/>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if variables.builtins.length > 0}
			<div>
				<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Filled in by the gateway</span>
				<div class="flex flex-wrap gap-1.5">
					{#each variables.builtins as name (name)}
						<span
							class="rounded-[6px] border border-sky-500/25 bg-sky-500/10 px-2 py-1 font-mono text-[11.5px] text-sky-300"
							title={BUILTINS.get(name)?.description}
						>
							{name}
						</span>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
