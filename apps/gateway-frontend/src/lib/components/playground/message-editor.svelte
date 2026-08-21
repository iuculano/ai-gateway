<script lang="ts" module>
import type { ChatCompletionRole } from '$lib/api/chat-completions';

/**
 * The roles the composer offers.
 *
 * Deliberately short of the request schema's full set: a `tool` message must
 * carry a tool_call_id matching an assistant tool_call earlier in the same
 * conversation, and a composer that let one be written without its partner
 * would produce requests the provider rejects. Few-shot examples, which is what
 * people actually reach for here, need only these four.
 */
export const COMPOSER_ROLES = ['system', 'developer', 'user', 'assistant'] as const;

export type ComposerRole = Extract<ChatCompletionRole, (typeof COMPOSER_ROLES)[number]>;

export interface DraftMessage {
  role: ComposerRole;
  content: string;
}

export function emptyDraft(role: ComposerRole = 'user'): DraftMessage {
  return { role: role, content: '' };
}
</script>

<script lang="ts">
import * as Select from '$lib/components/ui/select';
import { Textarea } from '$lib/components/ui/textarea';
import { ROLE_COLORS } from '$lib/data/conversation';

/**
 * One editable message in the request.
 *
 * Sibling to MessageList, which renders the same conversation read-only. The
 * role tints come from the same table so a role looks the same on both sides of
 * the page.
 */
let {
  message = $bindable(),
  disabled = false,
  onremove,
}: {
  message: DraftMessage;
  disabled?: boolean;
  /** Omitted for a message that cannot be removed - the last one standing. */
  onremove?: () => void;
} = $props();

const PLACEHOLDERS: Record<ComposerRole, string> = {
  system: 'Instructions the model should follow.',
  developer: 'Instructions the model should follow.',
  user: 'What do you want to ask?',
  assistant: 'A reply to prime the model with.',
};
</script>

<div class="flex items-start gap-2">
	<!-- Not bind:value: bits-ui types the value as a bare string, and the one
	     cast belongs here rather than spread over every read of message.role. -->
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
		class="max-h-64 min-h-[76px] rounded-lg border-line-strong bg-surface-3 px-[11px] py-2 text-[13px] leading-[1.6] focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-3"
	/>

	<button
		type="button"
		class="flex size-9 flex-none items-center justify-center rounded-lg border border-line-strong bg-surface-3 text-zinc-500 hover:bg-surface-4 hover:text-zinc-300 disabled:opacity-30"
		aria-label="Remove message"
		disabled={disabled || !onremove}
		onclick={() => onremove?.()}
	>
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
	</button>
</div>
