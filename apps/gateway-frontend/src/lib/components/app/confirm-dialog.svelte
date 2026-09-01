<script lang="ts">
import * as Dialog from '$lib/components/ui/dialog';

let {
  open = $bindable(false),
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'default',
  busy = false,
  onconfirm,
}: {
  open?: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  onconfirm: () => void;
} = $props();

const confirmClass = $derived(
  tone === 'danger' ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-emerald-500 text-[#04130d] hover:bg-[#13c98d]',
);
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="w-[420px] gap-0 overflow-hidden rounded-[14px] border border-line-strong bg-surface-2 p-0 shadow-[0_24px_70px_rgba(0,0,0,.6)] sm:max-w-[420px]"
		showCloseButton={false}
	>
		<div class="px-6 pt-[22px] pb-[18px]">
			<Dialog.Title class="mb-[6px] text-[16px] font-semibold tracking-[-0.01em]">
				{title}
			</Dialog.Title>
			<Dialog.Description class="text-[13px] leading-normal text-zinc-500">
				{description}
			</Dialog.Description>
		</div>
		<div class="flex gap-2.5 border-t border-line bg-surface-1 px-6 py-4">
			<button
				type="button"
				class="ml-auto h-[36px] rounded-lg border border-line-strong bg-surface-3 px-4 text-[13px] font-medium text-zinc-200 hover:bg-surface-4 disabled:opacity-60"
				disabled={busy}
				onclick={() => (open = false)}
			>
				Cancel
			</button>
			<button
				type="button"
				class="h-[36px] rounded-lg px-4 text-[13px] font-semibold disabled:opacity-60 {confirmClass}"
				disabled={busy}
				onclick={onconfirm}
			>
				{busy ? 'Working…' : confirmLabel}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
