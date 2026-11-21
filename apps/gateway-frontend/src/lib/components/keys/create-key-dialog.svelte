<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import type { ApiKey } from '#lib/api/types.ts';
import { copyToClipboard } from '#lib/clipboard.ts';
import { FIELD_BASE } from '#lib/components/app/field.ts';
import Panel from '#lib/components/app/panel.svelte';
import * as Dialog from '#lib/components/ui/dialog/index.ts';
import { Input } from '#lib/components/ui/input/index.ts';
import { Label } from '#lib/components/ui/label/index.ts';
import * as Select from '#lib/components/ui/select/index.ts';
import { Switch } from '#lib/components/ui/switch/index.ts';
import { CUSTOM_EXPIRY, EXPIRY_OPTIONS, keyChanges, keyForm, keyFormError, keyInput } from '#lib/data/api-keys.ts';
import { SCOPE_OPTIONS } from '#lib/data/scopes.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';

// One dialog for making a key and for editing one. With `apiKey` set it edits,
// and a new key ends on a second step that shows its secret the one time.

interface Props {
  open?: boolean;
  apiKey?: ApiKey;
  onsaved?: () => void;
}

let { open = $bindable(false), apiKey, onsaved }: Props = $props();

let step: 'form' | 'done' = $state('form');
let form = $state(keyForm());
let generatedKey = $state('');
let copied = $state(false);
let creating = $state(false);

// The key as it was when the dialog opened, which is what an edit is compared
// against.
let original: ApiKey | undefined = $state();

$effect(() => {
  if (!open) {
    return;
  }

  // Reset on opening and at no other time. Read tracked, the key would reset
  // the form again whenever the list behind the dialog refreshed.
  untrack(() => {
    original = apiKey;
    step = 'form';
    form = keyForm(apiKey);
    generatedKey = '';
    copied = false;
    creating = false;
  });
});

async function save(): Promise<void> {
  if (creating || apiKey?.revoked_at) {
    return;
  }

  const now = Date.now();
  const problem = keyFormError(form, original, now);

  if (problem) {
    toast.error(problem);

    return;
  }

  creating = true;

  try {
    const input = keyInput(form, original, now);

    if (original) {
      await dashboard.update(original.id, keyChanges(input, original));
      toast.success('Key updated');
      open = false;
      onsaved?.();
    } else {
      const created = await dashboard.create(input);

      generatedKey = created.key;
      step = 'done';
    }
  } catch (error) {
    const fallback = original ? 'Failed to update key.' : 'Failed to create key.';

    toast.error(error instanceof Error ? error.message : fallback);
  } finally {
    creating = false;
  }
}

async function copyGenerated(): Promise<void> {
  copied = false;

  // The key is held on to, so that a copy which finishes after the dialog has
  // moved on to another key does not mark that one as copied.
  const key = generatedKey;
  const succeeded = await copyToClipboard(key, 'Key copied to clipboard');

  if (generatedKey === key) {
    copied = succeeded;
  }
}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex max-h-[calc(100dvh-4rem)] w-[calc(100vw-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[640px]"
		showCloseButton={false}
		escapeKeydownBehavior={creating ? 'ignore' : 'close'}
		interactOutsideBehavior={creating ? 'ignore' : 'close'}
	>
		{#if step === 'form'}
			<div class="flex-none border-b border-line px-6 pt-[22px] pb-[18px]">
				<Dialog.Title class="mb-[5px] text-[17px] font-semibold tracking-[-0.01em]">
					{original ? 'Edit API key' : 'Create a new API key'}
				</Dialog.Title>
				<Dialog.Description class="text-[13px] text-zinc-500">
					{original ? 'Update this key’s details, permissions, and limits.' : 'Generate a secret key to authenticate requests from your application.'}
				</Dialog.Description>
			</div>

			<div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-[22px]">
				<div>
					<Label for="key-name" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">Key name</Label>
					<Input
						id="key-name"
						bind:value={form.name}
						placeholder="e.g. Production server"
						class="h-10 px-[13px] text-[13.5px] tracking-[-0.01em] {FIELD_BASE}"
					/>
				</div>

				<div>
					<Label for="key-description" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
						Description <span class="font-normal text-zinc-600">(optional)</span>
					</Label>
					<Input
						id="key-description"
						bind:value={form.description}
						placeholder="What will this key be used for?"
						class="h-10 px-[13px] text-[13.5px] tracking-[-0.01em] {FIELD_BASE}"
					/>
				</div>

				<div class="shrink-0">
					<Panel title="Permissions &amp; scopes">
						<div class="grid h-60 shrink-0 grid-cols-[max-content_minmax(0,1fr)_36px] content-start gap-x-3 overflow-y-auto overscroll-contain px-[13px]">
							{#each SCOPE_OPTIONS as scope (scope.id)}
								<div class="col-span-3 grid grid-cols-subgrid items-center border-b border-line py-2.5 last:border-b-0">
									<span class="whitespace-nowrap text-[13px] font-medium text-zinc-200">{scope.label}</span>
									<span class="min-w-0 truncate text-[11.5px] text-zinc-500" title={scope.desc}>{scope.desc}</span>
									<Switch
										checked={!!form.scopes[scope.id]}
										disabled={creating}
										onCheckedChange={(on) => (form.scopes[scope.id] = on)}
										aria-label={scope.label}
										class="h-5 w-9 shrink-0 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
									/>
								</div>
							{/each}
						</div>
					</Panel>
				</div>

				<div class="grid shrink-0 gap-3.5 sm:grid-cols-2">
					<Panel title="Rate limit">
						{#snippet actions()}
							<Switch
								bind:checked={form.rateLimitEnabled}
								disabled={creating}
								aria-label="Enable rate limit"
								class="h-5 w-9 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
							/>
						{/snippet}
						<div class="space-y-3 px-[13px] py-3">
							<div class="grid grid-cols-2 gap-3">
								<div>
									<Label for="key-rate-requests" class="mb-2 block text-[12.5px] text-zinc-200">Requests</Label>
									<Input id="key-rate-requests" type="number" min={1} max={2147483647} step={1} bind:value={form.rateLimitRequests} disabled={!form.rateLimitEnabled || creating} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
								</div>
								<div>
									<Label for="key-rate-window" class="mb-2 block text-[12.5px] text-zinc-200">Window (seconds)</Label>
									<Input id="key-rate-window" type="number" min={1} max={2147483647} step={1} bind:value={form.rateLimitWindow} disabled={!form.rateLimitEnabled || creating} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
								</div>
							</div>
							<p class="text-[11.5px] text-zinc-500">The first request starts the window. Once the limit is reached, further requests are blocked until the window resets.</p>
						</div>
					</Panel>

					<Panel title="Expiration">
						<div class="space-y-3 px-[13px] py-3">
							<div>
								<Label for="key-expiry-preset" class="mb-2 block text-[12.5px] text-zinc-200">Expires after</Label>
								<Select.Root type="single" bind:value={form.expiry} disabled={creating}>
									<Select.Trigger id="key-expiry-preset" aria-label="Expiration" class="data-[size=default]:h-9 w-full border-line-strong bg-surface-3 text-[12.5px] text-zinc-200 dark:bg-surface-3">
										{form.expiry}
									</Select.Trigger>
									<Select.Content>
										{#each Object.keys(EXPIRY_OPTIONS) as option (option)}
											<Select.Item value={option} label={option} />
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
							<div>
								<Label for="key-expiration" class="mb-2 block text-[12.5px] text-zinc-200">Custom date &amp; time</Label>
								<Input id="key-expiration" type="datetime-local" bind:value={form.customExpiry} disabled={creating || form.expiry !== CUSTOM_EXPIRY} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
							</div>
							<p class="text-[11.5px] text-zinc-500">Custom dates use your local time zone. Presets start when you save.</p>
						</div>
					</Panel>
				</div>
			</div>

			<div class="flex flex-none gap-2.5 border-t border-line bg-surface-1 px-6 py-4">
				<button
					type="button"
					class="ml-auto h-[38px] rounded-lg border border-line-strong bg-surface-3 px-4 text-[13.5px] font-medium text-zinc-200 hover:bg-surface-4"
					disabled={creating}
					onclick={() => (open = false)}
				>
					Cancel
				</button>
				<button
					type="button"
					class="h-[38px] rounded-lg bg-emerald-500 px-[18px] text-[13.5px] font-semibold text-[#04130d] shadow-[0_1px_0_rgba(255,255,255,.15)_inset] hover:bg-[#13c98d] disabled:opacity-60"
					disabled={creating}
					onclick={save}
				>
					{creating ? (original ? 'Saving…' : 'Creating…') : (original ? 'Save changes' : 'Create key')}
				</button>
			</div>
		{:else}
			<div class="flex-none px-6 pt-[26px] pb-2 text-center">
				<div
					class="mx-auto mb-3.5 flex size-[46px] items-center justify-center rounded-full bg-emerald-500/12 shadow-[0_0_0_1px_rgba(16,185,129,.25)]"
				>
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 12.5l4 4 8-9" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</div>
				<Dialog.Title class="mb-1.5 text-[17px] font-semibold">Your API key is ready</Dialog.Title>
				<Dialog.Description class="text-[13px] leading-normal text-zinc-500">
					Copy it now — for security, you won't be able to view the full key again.
				</Dialog.Description>
			</div>
			<div class="min-h-0 overflow-y-auto px-6 pt-[18px] pb-1.5">
				<div class="flex items-center gap-2 rounded-[9px] border border-line-strong bg-surface-3 py-2 pr-1.5 pl-3.5">
					<!-- One line, scrolled and not wrapped. -->
					<code
						class="key-value min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[13px] whitespace-nowrap text-emerald-400 select-all"
					>{generatedKey}</code>
					<button
						type="button"
						class="flex h-[34px] flex-none items-center gap-1.5 rounded-[7px] bg-emerald-500 px-[13px] text-[12.5px] font-semibold text-[#04130d] hover:bg-[#13c98d]"
						onclick={copyGenerated}
					>
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				<div
					class="mt-3.5 flex items-start gap-2 rounded-lg border border-amber-500/18 bg-amber-500/7 px-[13px] py-[11px]"
				>
					<svg width="15" height="15" viewBox="0 0 16 16" fill="none" class="mt-px flex-none"><path d="M8 2.5L14.5 13.5H1.5L8 2.5z" stroke="#f59e0b" stroke-width="1.4" stroke-linejoin="round" /><path d="M8 6.8v3M8 11.6v.01" stroke="#f59e0b" stroke-width="1.4" stroke-linecap="round" /></svg>
					<span class="text-xs leading-normal text-[#d4b483]">
						Store this key in a secure secrets manager. Never commit it to source control or expose it client-side.
					</span>
				</div>
			</div>
			<div class="flex flex-none px-6 py-[18px]">
				<button
					type="button"
					class="ml-auto h-[38px] rounded-lg border border-line-strong bg-surface-5 px-5 text-[13.5px] font-medium text-zinc-50 hover:bg-surface-6"
					onclick={() => (open = false)}
				>
					Done
				</button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	/*
	 * The key scrolls sideways, but the global scrollbar style carries a 3px
	 * border sized for full-height panes.
	 */
	.key-value {
		scrollbar-width: none;
	}
	.key-value::-webkit-scrollbar {
		display: none;
	}
</style>
