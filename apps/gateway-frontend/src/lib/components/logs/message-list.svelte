<script lang="ts">
import { ROLE_COLORS, type Turn } from '#lib/data/conversation.ts';
import MarkdownText from './markdown-text.svelte';

// The Simple rendering of a stored payload, which is the conversation without
// the parameters wrapped around it. Each role carries its label, and the tint
// is only there to make the alternation easy to scan.

interface Props {
  turns: Turn[];

  /**
   * Overrides the height. A log row can only afford the default, where a page
   * whose whole purpose is the transcript can afford more.
   */
  class?: string;

  /**
   * Pins the view to the newest text as it grows, for a response that is still
   * streaming in. It is off by default, because a stored payload is not going
   * anywhere and a reader's scroll position should not move under them.
   */
  autoscroll?: boolean;
  markdown?: boolean;
}

let { turns, class: className = 'max-h-72', autoscroll = false, markdown = false }: Props = $props();

let container: HTMLDivElement | null = $state(null);

$effect(() => {
  if (!autoscroll || !container) {
    return;
  }

  // The last turn's text is read as well as the count, so that this runs on
  // every token added to it and not only when a whole turn arrives. Without
  // that a growing message would scroll off the bottom of its own box.
  void turns.length;
  void turns.at(-1)?.text;

  container.scrollTop = container.scrollHeight;
});
</script>

<div bind:this={container} class="flex flex-col gap-3 overflow-auto px-[13px] py-3 {className}">
	{#each turns as turn, index (index)}
		<div class="flex min-w-0 flex-col gap-1">
			<span
				class="text-[10.5px] font-medium tracking-[.05em] uppercase"
				style:color={ROLE_COLORS[turn.role]}
			>
				{turn.role}
			</span>

			{#if turn.text}
				{#if markdown}
          <MarkdownText text={turn.text} />
        {:else}
        <p class="m-0 text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-zinc-300">{turn.text}</p>
        {/if}
			{/if}

			{#if turn.note}
				<span class="text-[11.5px] text-zinc-500 italic">{turn.note}</span>
			{/if}
		</div>
	{/each}
</div>
