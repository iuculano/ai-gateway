<script lang="ts">
import { Switch } from '#lib/components/ui/switch/index.ts';
import type { AutoRefresh } from '#lib/state/auto-refresh.svelte.ts';

// The tailing switch in a table's toolbar, shared so that every table spells
// the control the same way.

interface Props {
  auto: AutoRefresh;

  /**
   * False when the table is paged away from the head and has nothing to tail.
   */
  active?: boolean;

  /**
   * Explains the paused state, in the tooltip.
   */
  pausedLabel?: string;
}

let { auto, active = true, pausedLabel = 'paused' }: Props = $props();

const paused = $derived(auto.enabled && !active);

// The dot is always rendered and only its colour changes, clear when off, green
// while tailing and amber when left on with nothing to tail. Adding and
// removing it would change the control's width and push everything beside it
// along the toolbar on every toggle.
const dotClass = $derived(!auto.enabled ? 'bg-transparent' : paused ? 'bg-amber-500' : 'bg-emerald-500');

const title = $derived(!auto.enabled ? undefined : paused ? pausedLabel : `Every ${auto.intervalMs / 1000}s`);
</script>

<label class="flex flex-none items-center gap-2 text-[12.5px] whitespace-nowrap" {title}>
	<Switch
		checked={auto.enabled}
		onCheckedChange={(on) => (auto.enabled = on)}
		class="h-5 w-9 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
	/>
	<span class="flex items-center gap-[7px]">
		<!-- Dimmed alongside the amber dot, so that on but not tailing reads
		     without the tooltip, and without a word that would move things. -->
		<span class={paused ? 'text-zinc-600' : 'text-zinc-500'}>Auto-refresh</span>

		<span class="size-[5px] flex-none rounded-full {dotClass}" class:animate-pulse={auto.refreshing}></span>
	</span>
</label>
