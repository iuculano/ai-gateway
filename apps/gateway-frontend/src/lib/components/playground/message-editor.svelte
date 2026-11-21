<script lang="ts">
import { FIELD_BASE } from '#lib/components/app/field.ts';
import * as Select from '#lib/components/ui/select/index.ts';
import { Textarea } from '#lib/components/ui/textarea/index.ts';
import { ROLE_COLORS } from '#lib/data/conversation.ts';
import { COMPOSER_ROLES, type ComposerRole, type DraftMessage } from '#lib/data/playground-request.ts';

// One editable message in the request. MessageList renders the same
// conversation read-only, and the role tints come from the same table, so that
// a role looks the same on both sides of the page.

interface Props {
  message: DraftMessage;
  disabled?: boolean;

  /**
   * Left out for a message that cannot be removed, which is the last one
   * standing.
   */
  onremove?: () => void;
}

let { message = $bindable(), disabled = false, onremove }: Props = $props();

const PLACEHOLDERS: Record<ComposerRole, string> = {
  system: 'Instructions the model should follow.',
  developer: 'Instructions the model should follow.',
  user: 'What do you want to ask?',
  assistant: 'A reply to prime the model with.',
};
</script>

<div class="flex items-start gap-2">
	<!-- Set through the callback and not bound. bits-ui types the value as a bare
	     string, and the one cast belongs here and not on every read of the role. -->
	<Select.Root
		type="single"
		value={message.role}
		onValueChange={(role) => (message.role = role as ComposerRole)}
		{disabled}
	>
		<Select.Trigger
			class="h-9 w-[118px] flex-none rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-3 dark:hover:bg-surface-4"
		>
			<span class="flex items-center gap-2">
				<span class="size-[7px] flex-none rounded-full" style:background={ROLE_COLORS[message.role]}></span>
				{message.role}
			</span>
		</Select.Trigger>
		<Select.Content>
			{#each COMPOSER_ROLES as role (role)}
				<Select.Item value={role} label={role} />
			{/each}
		</Select.Content>
	</Select.Root>

	<Textarea
		bind:value={message.content}
		placeholder={PLACEHOLDERS[message.role]}
		{disabled}
		rows={3}
		class="max-h-64 min-h-[76px] px-[11px] py-2 text-[13px] leading-[1.6] {FIELD_BASE}"
	/>

	<button
		type="button"
		class="flex size-9 flex-none items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-30"
		aria-label="Remove message"
		disabled={disabled || !onremove}
		onclick={onremove}
	>
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
	</button>
</div>
