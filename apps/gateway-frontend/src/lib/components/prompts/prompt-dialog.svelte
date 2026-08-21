<script lang="ts">
import { toast } from 'svelte-sonner';
import type { Prompt } from '$lib/api/types';
import type { Pair } from '$lib/components/app/key-value-editor.svelte';
import KeyValueEditor, { toPairs, toRecord } from '$lib/components/app/key-value-editor.svelte';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { prompts } from '$lib/state/prompts.svelte';

/**
 * Create and edit are the same form over the same three fields, so they are one
 * component: `prompt` set means edit, and the title, the submit verb and the
 * request are the only things that differ.
 *
 * The template text is deliberately not here. A prompt owns a name and its
 * labels; the text belongs to a version, and editing it through this form would
 * hide the fact that it is versioned at all.
 */
let {
  open = $bindable(false),
  prompt = null,
}: {
  open?: boolean;
  /** The prompt being edited, or null to create a new one. */
  prompt?: Prompt | null;
} = $props();

const editing = $derived(prompt !== null);

let name = $state('');
let description = $state('');
let tagPairs: Pair[] = $state([]);
let saving = $state(false);

// Reset on open rather than on close, so the form is never seen re-populating
// as the dialog animates away.
$effect(() => {
  if (open) {
    name = prompt?.name ?? '';
    description = prompt?.description ?? '';
    tagPairs = toPairs(prompt?.tags);
    saving = false;
  }
});

const FIELD_CLASS =
  'h-10 rounded-lg border-line-strong bg-surface-3 px-[13px] text-[13.5px] tracking-[-0.01em] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';

async function save() {
  if (!name.trim()) {
    toast.error('Give the prompt a name first.');
    return;
  }

  const tags = toRecord(tagPairs);

  saving = true;

  try {
    if (prompt) {
      // null rather than undefined for a description the user cleared: drizzle
      // skips undefined columns on an update, so undefined would silently keep
      // the old text. `{}` for tags, for the same reason.
      await prompts.update(prompt.id, {
        name: name.trim(),
        description: description.trim() || null,
        tags: tags ?? {},
      });

      toast.success('Prompt updated');
    } else {
      await prompts.create({
        name: name.trim(),
        description: description.trim() || undefined,
        tags,
      });

      toast.success('Prompt created');
    }

    open = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to save the prompt.');
  } finally {
    saving = false;
  }
}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex max-h-[calc(100dvh-4rem)] w-[520px] flex-col gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[520px]"
		showCloseButton={false}
	>
		<div class="flex-none border-b border-line px-6 pt-[22px] pb-[18px]">
			<Dialog.Title class="mb-[5px] text-[17px] font-semibold tracking-[-0.01em]">
				{editing ? 'Edit prompt' : 'Create a prompt'}
			</Dialog.Title>
			<Dialog.Description class="text-[13px] text-zinc-500">
				{#if editing}
					Renaming affects every caller that resolves this prompt by name.
				{:else}
					A prompt starts empty. Add a version to give it text.
				{/if}
			</Dialog.Description>
		</div>

		<div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-[22px]">
			<div>
				<Label for="prompt-name" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Name</Label>
				<Input id="prompt-name" bind:value={name} placeholder="e.g. support-triage" class="{FIELD_CLASS} font-mono text-[13px]" />
				<p class="mt-[7px] text-[11.5px] leading-normal text-zinc-600">
					Unique within your organization. This is how the prompt is referred to from a request.
				</p>
			</div>

			<div>
				<Label for="prompt-description" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Description <span class="font-normal text-zinc-600">(optional)</span>
				</Label>
				<Input
					id="prompt-description"
					bind:value={description}
					placeholder="What is this prompt for?"
					class={FIELD_CLASS}
				/>
			</div>

			<div>
				<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Tags <span class="font-normal text-zinc-600">(optional)</span>
				</span>
				<p class="mb-2.5 text-[11.5px] leading-normal text-zinc-600">
					Labels for filtering this list later. They play no part in rendering.
				</p>
				<KeyValueEditor bind:pairs={tagPairs} keyPlaceholder="label" valuePlaceholder="value" addLabel="Add tag" />
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
				disabled={saving}
				onclick={save}
			>
				{#if saving}
					Saving…
				{:else}
					{editing ? 'Save changes' : 'Create prompt'}
				{/if}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
