<script lang="ts">
import { Switch } from '$lib/components/ui/switch';
import type { AutoRefresh } from '$lib/state/auto-refresh.svelte';

/**
 * The tailing switch in a table's toolbar.
 *
 * Shared so the five tables cannot end up with five spellings of the same
 * control - the logs page had the only one, and the rest had none.
 */
let {
  auto,
  active = true,
  pausedLabel = 'paused',
}: {
  auto: AutoRefresh;
  /** False when the table is paged away from the head and has nothing to tail. */
  active?: boolean;
  /** Explains the paused state, in the tooltip. */
  pausedLabel?: string;
} = $props();

const paused = $derived(auto.enabled && !active);

/**
 * The indicator is ALWAYS rendered, and only its colour changes.
 *
 * It used to be added and removed with the switch, which changed the control's
 * width and shoved everything beside it along the toolbar on every toggle. Its
 * state is carried by colour and by the tooltip instead, so nothing reflows:
 * transparent when off, emerald while tailing, amber when left on with nothing
 * to tail.
 */
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
		<!-- Dimmed alongside the amber dot, so "on but not tailing" reads without
		     needing the tooltip - and without adding a word that would move things. -->
		<span class={paused ? 'text-zinc-600' : 'text-zinc-500'}>Auto-refresh</span>

		<span class="size-[5px] flex-none rounded-full {dotClass}" class:animate-pulse={auto.refreshing}></span>
	</span>
</label>
