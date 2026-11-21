<script lang="ts">
import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';

interface Props {
  disabled?: boolean;
  onclick: () => void;
}

let { disabled = false, onclick }: Props = $props();
</script>

<ToolbarButton {disabled} {onclick}>
	<RotateCwIcon class="size-[13px]" />
	Refresh
</ToolbarButton>
