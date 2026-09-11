<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import type { UpdateApiKeyInput } from '$lib/api/api-keys';
import type { ApiKey } from '$lib/api/types';
import { copyToClipboard } from '$lib/clipboard';
import Panel from '$lib/components/app/panel.svelte';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { Switch } from '$lib/components/ui/switch';
import { SCOPE_OPTIONS } from '$lib/data/scopes';
import { dashboard } from '$lib/state/dashboard.svelte';

let {
  open = $bindable(false),
  apiKey,
  onsaved,
}: {
  open?: boolean;
  apiKey?: ApiKey;
  onsaved?: () => void;
} = $props();

const EXPIRY_OPTIONS: Record<string, number | null> = {
  Never: null,
  '1 day': 1,
  '7 days': 7,
  '30 days': 30,
  '90 days': 90,
  '1 year': 365,
  'Custom date & time': null,
};

let step: 'form' | 'done' = $state('form');
let name = $state('');
let description = $state('');
let scopes: Record<string, boolean> = $state({});
let expiry = $state('Never');
let customExpiry = $state('');
let rateLimitEnabled = $state(false);
let rateLimitRequests: number | undefined = $state(100);
let rateLimitWindow: number | undefined = $state(60);
let generatedKey = $state('');
let copied = $state(false);
let creating = $state(false);
let original: ApiKey | undefined = $state();
let originalExpiry = $state('');

$effect(() => {
  if (!open) return;
  untrack(() => {
    original = apiKey;
    step = 'form';
    name = original?.name ?? '';
    description = original?.description ?? '';
    scopes = original
      ? Object.fromEntries(
          original.scopes
            .split(' ')
            .filter(Boolean)
            .map((scope) => [scope, true]),
        )
      : { 'api-keys:read': true };
    expiry = original?.expires_at ? 'Custom date & time' : 'Never';
    const date = original?.expires_at ? new Date(original.expires_at) : null;
    customExpiry = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
    originalExpiry = customExpiry;
    rateLimitEnabled = original?.rate_limit_requests != null;
    rateLimitRequests = original?.rate_limit_requests ?? 100;
    rateLimitWindow = original?.rate_limit_window ?? 60;
    generatedKey = '';
    copied = false;
    creating = false;
  });
});

async function save() {
  if (creating || apiKey?.revoked_at) return;
  if (!name.trim()) {
    toast.error('Give the key a name first.');
    return;
  }

  const days = EXPIRY_OPTIONS[expiry];
  const expiryUnchanged =
    original &&
    (original.expires_at ? expiry === 'Custom date & time' && customExpiry === originalExpiry : expiry === 'Never');
  const expiresAt =
    expiry === 'Custom date & time' ? new Date(customExpiry) : days ? new Date(Date.now() + days * 86_400_000) : null;
  if (!expiryUnchanged && expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    toast.error('Choose an expiration date and time in the future.');
    return;
  }
  if (
    rateLimitEnabled &&
    (!Number.isInteger(rateLimitRequests) ||
      !rateLimitRequests ||
      rateLimitRequests < 1 ||
      rateLimitRequests > 2_147_483_647 ||
      !Number.isInteger(rateLimitWindow) ||
      !rateLimitWindow ||
      rateLimitWindow < 1 ||
      rateLimitWindow > 2_147_483_647)
  ) {
    toast.error('Enter whole numbers between 1 and 2,147,483,647 for requests and window seconds.');
    return;
  }
  creating = true;

  try {
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      scopes: Object.keys(scopes)
        .filter((scope) => scopes[scope])
        .join(' '),
      expires_at: expiryUnchanged ? (original?.expires_at ?? null) : (expiresAt?.toISOString() ?? null),
      rate_limit_requests: rateLimitEnabled ? Number(rateLimitRequests) : null,
      rate_limit_window: rateLimitEnabled ? Number(rateLimitWindow) : null,
    };
    if (original) {
      const updates: UpdateApiKeyInput = {};
      if (input.name !== original.name) updates.name = input.name;
      if (input.description !== original.description) updates.description = input.description;
      if (input.scopes !== original.scopes) updates.scopes = input.scopes;
      if (input.expires_at !== original.expires_at) updates.expires_at = input.expires_at;
      if (
        input.rate_limit_requests !== original.rate_limit_requests ||
        input.rate_limit_window !== original.rate_limit_window
      ) {
        updates.rate_limit_requests = input.rate_limit_requests;
        updates.rate_limit_window = input.rate_limit_window;
      }
      await dashboard.update(original.id, updates);
      toast.success('Key updated');
      open = false;
      onsaved?.();
    } else {
      const created = await dashboard.create(input);
      generatedKey = created.key;
      step = 'done';
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : original ? 'Failed to update key.' : 'Failed to create key.');
  } finally {
    creating = false;
  }
}

async function copyGenerated() {
  copied = false;
  const key = generatedKey;
  const success = await copyToClipboard(key, 'Key copied to clipboard');
  if (generatedKey === key) copied = success;
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
						bind:value={name}
						placeholder="e.g. Production server"
						class="h-10 rounded-lg border-line-strong bg-surface-3 px-[13px] text-[13.5px] tracking-[-0.01em] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
					/>
				</div>

				<div>
					<Label for="key-description" class="mb-[7px] block text-[12.5px] font-medium text-zinc-200">
						Description <span class="font-normal text-zinc-600">(optional)</span>
					</Label>
					<Input
						id="key-description"
						bind:value={description}
						placeholder="What will this key be used for?"
						class="h-10 rounded-lg border-line-strong bg-surface-3 px-[13px] text-[13.5px] tracking-[-0.01em] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
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
										checked={!!scopes[scope.id]}
										disabled={creating}
										onCheckedChange={(on) => (scopes[scope.id] = on)}
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
								bind:checked={rateLimitEnabled}
								disabled={creating}
								aria-label="Enable rate limit"
								class="h-5 w-9 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
							/>
						{/snippet}
						<div class="space-y-3 px-[13px] py-3">
							<div class="grid grid-cols-2 gap-3">
								<div>
									<Label for="key-rate-requests" class="mb-2 block text-[12.5px] text-zinc-200">Requests</Label>
									<Input id="key-rate-requests" type="number" min={1} max={2147483647} step={1} bind:value={rateLimitRequests} disabled={!rateLimitEnabled || creating} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
								</div>
								<div>
									<Label for="key-rate-window" class="mb-2 block text-[12.5px] text-zinc-200">Window (seconds)</Label>
									<Input id="key-rate-window" type="number" min={1} max={2147483647} step={1} bind:value={rateLimitWindow} disabled={!rateLimitEnabled || creating} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
								</div>
							</div>
							<p class="text-[11.5px] text-zinc-500">The first request starts the window. Once the limit is reached, further requests are blocked until the window resets.</p>
						</div>
					</Panel>

					<Panel title="Expiration">
						<div class="space-y-3 px-[13px] py-3">
							<div>
								<Label for="key-expiry-preset" class="mb-2 block text-[12.5px] text-zinc-200">Expires after</Label>
								<Select.Root type="single" bind:value={expiry} disabled={creating}>
									<Select.Trigger id="key-expiry-preset" aria-label="Expiration" class="data-[size=default]:h-9 w-full border-line-strong bg-surface-3 text-[12.5px] text-zinc-200 dark:bg-surface-3">
										{expiry}
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
								<Input id="key-expiration" type="datetime-local" bind:value={customExpiry} disabled={creating || expiry !== 'Custom date & time'} class="h-9 border-line-strong bg-surface-3 dark:bg-surface-3" />
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
					<!-- One line, scrolled rather than wrapped. A 64-character key needs
					     ~500px and the dialog affords ~336px, so break-all used to wrap it
					     onto three ragged lines beside a fixed-height button. min-w-0 is
					     what lets the flex child shrink below its content width at all.
					     select-all keeps manual copying possible now that the tail is off
					     screen. -->
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
	 * The key scrolls sideways rather than wrapping, but the global scrollbar
	 * style carries a 3px border sized for full-height panes - inside a 34px
	 * row it swallows most of the box. Hidden here only; the content stays
	 * reachable by dragging a selection, and the Copy button is the real path.
	 */
	.key-value {
		scrollbar-width: none;
	}
	.key-value::-webkit-scrollbar {
		display: none;
	}
</style>
