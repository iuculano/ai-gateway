<script lang="ts">
import { ROLE_COLORS, type Turn } from '$lib/data/conversation';

/**
 * The 'Simple' rendering of a stored payload: the conversation, without the
 * parameters wrapped around it.
 *
 * Roles are tinted rather than labelled with colour alone - the label carries
 * the meaning, the tint only makes the alternation easy to scan.
 */
let {
  turns,
  class: className = 'max-h-72',
  autoscroll = false,
}: {
  turns: Turn[];
  /**
   * Height override. A log row can only afford the 72 that is the default; a
   * page whose whole purpose is the transcript can afford more.
   */
  class?: string;
  /**
   * Pins the view to the newest text as it grows, for a response still
   * streaming in. Off by default - a stored payload is not going anywhere, and
   * moving a reader's scroll position under them would be wrong.
   */
  autoscroll?: boolean;
} = $props();

let container: HTMLDivElement | null = $state(null);

// The last turn's text is read explicitly so the effect re-runs on every token
// appended to it, not only when a whole turn is added. Without that a growing
// message would scroll off the bottom of its own box and leave the reader
// watching a stationary first line.
$effect(() => {
  if (!autoscroll || !container) return;

  void turns.length;
  void turns.at(-1)?.text;

  container.scrollTop = container.scrollHeight;
});
</script>

<div bind:this={container} class="flex flex-col gap-3 overflow-auto px-[13px] py-3 {className}">
	{#each turns as turn, index (index)}
		<div class="flex flex-col gap-1">
			<span
				class="text-[10.5px] font-medium tracking-[.05em] uppercase"
				style:color={ROLE_COLORS[turn.role]}
			>
				{turn.role}
			</span>

			{#if turn.text}
				<p class="m-0 text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-zinc-300">{turn.text}</p>
			{/if}

			{#if turn.note}
				<span class="text-[11.5px] text-zinc-500 italic">{turn.note}</span>
			{/if}
		</div>
	{/each}
</div>
