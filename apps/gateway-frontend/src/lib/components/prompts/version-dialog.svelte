<script lang="ts">
import { toast } from 'svelte-sonner';
import { getPromptVersion } from '#lib/api/prompts.ts';
import { FIELD_BASE } from '#lib/components/app/field.ts';
import * as Dialog from '#lib/components/ui/dialog/index.ts';
import { Label } from '#lib/components/ui/label/index.ts';
import { Textarea } from '#lib/components/ui/textarea/index.ts';
import { extractVariables } from '#lib/data/prompts.ts';
import { prompts } from '#lib/state/prompts.svelte.ts';

// The template editor, for a new version or an existing one.
//
// Making one never overwrites anything, since a new version is appended and
// numbered by the server. Editing rewrites a version in place and changes what
// everything already pointing at it will render, which is why the two look
// different and are not the same save.

interface Props {
  open?: boolean;
  promptId: string;
  promptName: string;

  /**
   * The version to edit, or null to append a new one.
   */
  version?: number | null;
}

let { open = $bindable(false), promptId, promptName, version = null }: Props = $props();

let template = $state('');
let loading = $state(false);
let saving = $state(false);

const editing = $derived(version !== null);
const variables = $derived(extractVariables(template));

// The version and the prompt are read here as well as `open`, so that reopening
// on a different row does not leave the previous template in the box.
$effect(() => {
  if (!open) {
    return;
  }

  template = '';
  saving = false;

  if (version === null) {
    loading = false;

    return;
  }

  loading = true;

  getPromptVersion(promptId, version)
    .then((loaded) => {
      template = loaded.prompt;
    })
    .catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to load the version.');
      open = false;
    })
    .finally(() => {
      loading = false;
    });
});

async function save(): Promise<void> {
  if (!template.trim()) {
    toast.error('The template cannot be empty.');

    return;
  }

  saving = true;

  try {
    if (version === null) {
      const created = await prompts.addVersion(promptId, { prompt: template });

      toast.success(`Version ${created.version} created`);
    } else {
      await prompts.editVersion(promptId, version, { prompt: template });
      toast.success(`Version ${version} updated`);
    }

    open = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to save the version.');
  } finally {
    saving = false;
  }
}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex max-h-[calc(100dvh-4rem)] w-[680px] flex-col gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[680px]"
		showCloseButton={false}
	>
		<div class="flex-none border-b border-line px-6 pt-[22px] pb-[18px]">
			<Dialog.Title class="mb-[5px] text-[17px] font-semibold tracking-[-0.01em]">
				{editing ? `Edit version ${version}` : 'New version'}
			</Dialog.Title>
			<Dialog.Description class="text-[13px] text-zinc-500">
				{#if editing}
					Rewrites v{version} of <code class="font-mono text-zinc-400">{promptName}</code> in place. Anything pointing at
					this version renders the new text.
				{:else}
					Appended to <code class="font-mono text-zinc-400">{promptName}</code>. The version number is assigned by the
					server.
				{/if}
			</Dialog.Description>
		</div>

		<div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-[22px]">
			<div>
				<Label for="version-template" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Template</Label>
				<Textarea
					id="version-template"
					bind:value={template}
					disabled={loading}
					rows={14}
					spellcheck={false}
					placeholder={'You are a support agent. Today is {{ aig.date }}.\n\nAnswer the question from {{ customer_name }}.'}
					class="min-h-[260px] resize-y px-[13px] py-[11px] font-mono text-[13px] leading-relaxed {FIELD_BASE}"
				/>
				<p class="mt-[7px] text-[11.5px] leading-normal text-zinc-600">
					Wrap a variable in <code class="font-mono text-zinc-500">{'{{ braces }}'}</code>. Names under
					<code class="font-mono text-zinc-500">aig.</code> are filled in for you.
				</p>
			</div>

			<div>
				<span class="mb-2.5 block text-[12.5px] font-medium text-zinc-200">
					Variables detected
					<span class="ml-1 font-normal text-zinc-600">
						{variables.inputs.length + variables.builtins.length}
					</span>
				</span>

				{#if variables.inputs.length === 0 && variables.builtins.length === 0}
					<p class="text-[12.5px] text-zinc-600">
						None — this template renders as written, with nothing to supply.
					</p>
				{:else}
					<div class="flex flex-wrap gap-1.5">
						{#each variables.builtins as name (name)}
							<span
								class="rounded-[6px] border border-sky-500/25 bg-sky-500/10 px-2 py-1 font-mono text-[11.5px] text-sky-300"
							>
								{name}
							</span>
						{/each}
						{#each variables.inputs as name (name)}
							<span class="rounded-[6px] border border-line-strong bg-surface-3 px-2 py-1 font-mono text-[11.5px] text-zinc-300">
								{name}
							</span>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<div class="flex flex-none gap-2.5 border-t border-line bg-surface-1 px-6 py-4">
			<button
				type="button"
				class="ml-auto h-[38px] rounded-lg border border-line-strong bg-surface-3 px-4 text-[13.5px] font-medium text-zinc-200 hover:bg-surface-4 disabled:opacity-60"
				disabled={saving}
				onclick={() => (open = false)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="h-[38px] rounded-lg bg-emerald-500 px-[18px] text-[13.5px] font-semibold text-[#04130d] shadow-[0_1px_0_rgba(255,255,255,.15)_inset] hover:bg-[#13c98d] disabled:opacity-60"
				disabled={saving || loading}
				onclick={save}
			>
				{#if saving}
					Saving…
				{:else}
					{editing ? 'Save version' : 'Create version'}
				{/if}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
