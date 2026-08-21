<script lang="ts">
import { toast } from 'svelte-sonner';
import type { Webhook } from '$lib/api/types';
import type { Pair } from '$lib/components/app/key-value-editor.svelte';
import KeyValueEditor, { toPairs, toRecord } from '$lib/components/app/key-value-editor.svelte';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { webhooks } from '$lib/state/webhooks.svelte';

/**
 * Create and edit are the same form over the same five fields, so they are one
 * component: `webhook` set means edit, and the title, the submit verb and the
 * request are the only things that differ.
 */
let {
  open = $bindable(false),
  webhook = null,
}: {
  open?: boolean;
  /** The endpoint being edited, or null to create a new one. */
  webhook?: Webhook | null;
} = $props();

const editing = $derived(webhook !== null);

let name = $state('');
let description = $state('');
let endpoint = $state('');
let filterPairs: Pair[] = $state([]);
let tagPairs: Pair[] = $state([]);
let saving = $state(false);

// Reset on open rather than on close, so the form is never seen re-populating
// as the dialog animates away. Reads `webhook` too: reopening on a different
// row must not leave the previous row's values in the boxes.
$effect(() => {
  if (open) {
    name = webhook?.name ?? '';
    description = webhook?.description ?? '';
    endpoint = webhook?.endpoint ?? '';
    filterPairs = toPairs(webhook?.filter);
    tagPairs = toPairs(webhook?.tags);
    saving = false;
  }
});

const FIELD_CLASS =
  'h-10 rounded-lg border-line-strong bg-surface-3 px-[13px] text-[13.5px] tracking-[-0.01em] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3';

/**
 * Endpoint validation is client-side only.
 *
 * The API takes `endpoint` as a bare string, so nothing downstream rejects a
 * typo - the worker simply POSTs to it and records whatever failure comes back.
 * Catching it here is what keeps that out of the delivery history.
 */
function endpointProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL, including https://.';
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The endpoint must be an http:// or https:// URL.';
  }

  return null;
}

async function save() {
  if (!name.trim()) {
    toast.error('Give the webhook a name first.');
    return;
  }

  const problem = endpointProblem(endpoint.trim());
  if (problem) {
    toast.error(problem);
    return;
  }

  const filter = toRecord(filterPairs);
  const tags = toRecord(tagPairs);

  saving = true;

  try {
    if (webhook) {
      // `{}` rather than undefined for a map the user emptied: drizzle skips
      // undefined columns on an update, so undefined would silently keep the
      // old rules. An empty filter matches every event, which is the same thing
      // no filter at all means.
      await webhooks.update(webhook.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        endpoint: endpoint.trim(),
        filter: filter ?? {},
        tags: tags ?? {},
      });

      toast.success('Webhook updated');
    } else {
      await webhooks.create({
        name: name.trim(),
        description: description.trim() || undefined,
        endpoint: endpoint.trim(),
        filter,
        tags,
      });

      toast.success('Webhook created');
    }

    open = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to save the webhook.');
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
				{editing ? 'Edit webhook' : 'Create a webhook'}
			</Dialog.Title>
			<Dialog.Description class="text-[13px] text-zinc-500">
				Relay POSTs the id of every matching log to your endpoint as it is recorded.
			</Dialog.Description>
		</div>

		<div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-[22px]">
			<div>
				<Label for="webhook-name" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Name</Label>
				<Input id="webhook-name" bind:value={name} placeholder="e.g. Billing pipeline" class={FIELD_CLASS} />
			</div>

			<div>
				<Label for="webhook-description" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Description <span class="font-normal text-zinc-600">(optional)</span>
				</Label>
				<Input
					id="webhook-description"
					bind:value={description}
					placeholder="What consumes this endpoint?"
					class={FIELD_CLASS}
				/>
			</div>

			<div>
				<Label for="webhook-endpoint" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Endpoint URL
				</Label>
				<Input
					id="webhook-endpoint"
					bind:value={endpoint}
					placeholder="https://example.com/hooks/relay"
					class="{FIELD_CLASS} font-mono text-[13px]"
				/>
				<p class="mt-[7px] text-[11.5px] leading-normal text-zinc-600">
					Receives a JSON body of <code class="font-mono text-zinc-500">{'{ webhook_id, log_id }'}</code> on every match.
				</p>
			</div>

			<div>
				<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Filter <span class="font-normal text-zinc-600">(optional)</span>
				</span>
				<p class="mb-2.5 text-[11.5px] leading-normal text-zinc-600">
					Only deliver logs whose tags carry every pair below. Leave empty to receive everything.
				</p>
				<KeyValueEditor bind:pairs={filterPairs} keyPlaceholder="tag" valuePlaceholder="value" addLabel="Add rule" />
			</div>

			<div>
				<span class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
					Tags <span class="font-normal text-zinc-600">(optional)</span>
				</span>
				<p class="mb-2.5 text-[11.5px] leading-normal text-zinc-600">
					Labels on the webhook itself, for filtering this list later. They play no part in delivery.
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
					{editing ? 'Save changes' : 'Create webhook'}
				{/if}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
