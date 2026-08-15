<script lang="ts">
import { toast } from 'svelte-sonner';
import * as Dialog from '$lib/components/ui/dialog';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import * as Select from '$lib/components/ui/select';
import { SCOPE_OPTIONS } from '$lib/data/scopes';
import { dashboard } from '$lib/state/dashboard.svelte';

let { open = $bindable(false) }: { open?: boolean } = $props();

const EXPIRY_OPTIONS: Record<string, number | null> = {
  Never: null,
  '30 days': 30,
  '90 days': 90,
  '1 year': 365,
};

let step: 'form' | 'done' = $state('form');
let name = $state('');
let description = $state('');
let scopes: Record<string, boolean> = $state({});
let expiry = $state('Never');
let generatedKey = $state('');
let copied = $state(false);
let creating = $state(false);

$effect(() => {
  if (open) {
    step = 'form';
    name = '';
    description = '';
    scopes = { 'api-keys:read': true };
    expiry = 'Never';
    generatedKey = '';
    copied = false;
    creating = false;
  }
});

async function create() {
  if (!name.trim()) {
    toast.error('Give the key a name first.');
    return;
  }

  const days = EXPIRY_OPTIONS[expiry];
  creating = true;

  try {
    const created = await dashboard.create({
      name: name.trim(),
      description: description.trim() || undefined,
      scopes: Object.keys(scopes)
        .filter((s) => scopes[s])
        .join(' '),
      expires_at: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
    });

    generatedKey = created.key;
    step = 'done';
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to create key.');
  } finally {
    creating = false;
  }
}

function copyGenerated() {
  navigator.clipboard?.writeText(generatedKey).catch(() => {});
  copied = true;
  toast.success('Key copied to clipboard');
}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="flex max-h-[calc(100dvh-4rem)] w-[480px] flex-col gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[480px]"
		showCloseButton={false}
	>
		{#if step === 'form'}
			<div class="flex-none border-b border-line px-6 pt-[22px] pb-[18px]">
				<Dialog.Title class="mb-[5px] text-[17px] font-semibold tracking-[-0.01em]">
					Create a new API key
				</Dialog.Title>
				<Dialog.Description class="text-[13px] text-zinc-500">
					Generate a secret key to authenticate requests from your application.
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

				<div>
					<span class="mb-2 block text-[12.5px] font-medium text-zinc-200">Scopes</span>
					<div class="flex flex-wrap gap-2">
						{#each SCOPE_OPTIONS as scope (scope.id)}
							{@const on = !!scopes[scope.id]}
							<button
								type="button"
								class="inline-flex h-[34px] items-center gap-2 rounded-lg border px-[13px] text-[12.5px] font-medium {on
									? 'border-emerald-500/33 bg-emerald-500/10 text-zinc-200'
									: 'border-line-strong bg-surface-3 text-zinc-400'}"
								onclick={() => (scopes[scope.id] = !on)}
							>
								<span
									class="flex size-3.5 items-center justify-center rounded border-[1.4px] {on
										? 'border-emerald-500 bg-emerald-500'
										: 'border-zinc-700 bg-transparent'}"
								>
									{#if on}
										<svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3" stroke="#04130d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
									{/if}
								</span>
								{scope.label}
							</button>
						{/each}
					</div>
				</div>

				<div class="flex items-center justify-between rounded-lg border border-line-strong bg-surface-3 px-[13px] py-[11px]">
					<div>
						<div class="text-[13px] font-medium text-zinc-200">Expiration</div>
						<div class="text-[11.5px] text-zinc-600">Key auto-revokes after this period</div>
					</div>
					<Select.Root type="single" bind:value={expiry}>
						<Select.Trigger
							class="h-8 rounded-[7px] border-line-strong bg-surface-5 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-5 dark:hover:bg-surface-6"
						>
							{expiry}
						</Select.Trigger>
						<Select.Content>
							{#each Object.keys(EXPIRY_OPTIONS) as option (option)}
								<Select.Item value={option} label={option} />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<div class="flex flex-none gap-2.5 border-t border-line bg-surface-1 px-6 py-4">
				<button
					type="button"
					class="ml-auto h-[38px] rounded-lg border border-line-strong bg-surface-3 px-4 text-[13.5px] font-medium text-zinc-200 hover:bg-surface-4"
					onclick={() => (open = false)}
				>
					Cancel
				</button>
				<button
					type="button"
					class="h-[38px] rounded-lg bg-emerald-500 px-[18px] text-[13.5px] font-semibold text-[#04130d] shadow-[0_1px_0_rgba(255,255,255,.15)_inset] hover:bg-[#13c98d] disabled:opacity-60"
					disabled={creating}
					onclick={create}
				>
					{creating ? 'Creating…' : 'Create key'}
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
