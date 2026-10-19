<script lang="ts">
import { goto } from '$app/navigation';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';

/** Switches between the playground's endpoints, one route each so a tab can be linked to. */
let { current }: { current: 'chat' | 'decisions' } = $props();

const TABS = [
  { id: 'chat' as const, label: 'Chat', href: '/playground' },
  { id: 'decisions' as const, label: 'Decisions', href: '/playground/decisions' },
];
</script>

<FilterTabs
	tabs={TABS}
	bind:value={() => current, (next) => void goto(TABS.find((tab) => tab.id === next)?.href ?? '/playground')}
/>
