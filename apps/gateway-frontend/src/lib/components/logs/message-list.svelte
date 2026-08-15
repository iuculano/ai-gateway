<script lang="ts">
import type { Turn, TurnRole } from '$lib/data/conversation';

/**
 * The 'Simple' rendering of a stored payload: the conversation, without the
 * parameters wrapped around it.
 *
 * Roles are tinted rather than labelled with colour alone - the label carries
 * the meaning, the tint only makes the alternation easy to scan.
 */
let { turns }: { turns: Turn[] } = $props();

const ROLE_COLORS: Record<TurnRole, string> = {
  system: '#a1a1aa',
  developer: '#a1a1aa',
  user: '#60a5fa',
  assistant: '#10b981',
  tool: '#c084fc',
};
</script>

<div class="flex max-h-72 flex-col gap-3 overflow-auto px-[13px] py-3">
	{#each turns as turn, index (index)}
		<div class="flex flex-col gap-1">
			<span
				class="text-[10.5px] font-medium tracking-[.05em] uppercase"
				style:color={ROLE_COLORS[turn.role]}
			>
				{turn.role}
			</span>

			{#if turn.text}
				<!-- whitespace-pre-wrap so a prompt's own line breaks and indentation
				     survive; they are frequently load-bearing in a system prompt. -->
				<p class="m-0 text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-zinc-300">{turn.text}</p>
			{/if}

			{#if turn.note}
				<span class="text-[11.5px] text-zinc-500 italic">{turn.note}</span>
			{/if}
		</div>
	{/each}
</div>
