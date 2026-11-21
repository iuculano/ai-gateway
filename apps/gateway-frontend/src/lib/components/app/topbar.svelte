<script lang="ts">
import { dashboard } from '#lib/state/dashboard.svelte.ts';
import { page } from '$app/state';

interface Section {
  prefix: string;
  label: string;

  /**
   * What the search box reads on a section whose page filters by it. A section
   * without one has no search box, because nothing there would read what was
   * typed.
   */
  placeholder?: string;
}

// Keys come first, because the first entry is also what anything unlisted
// falls back to.
const SECTIONS: Section[] = [
  { prefix: '/keys', label: 'API Keys', placeholder: 'Search keys…' },
  { prefix: '/logs', label: 'Logs', placeholder: 'Search logs…' },
  { prefix: '/traces', label: 'Traces', placeholder: 'Search trace names, IDs and tags…' },
  { prefix: '/models', label: 'Models' },
  { prefix: '/overview', label: 'Overview' },
  { prefix: '/playground', label: 'Playground' },
  { prefix: '/analytics', label: 'Analytics' },
  { prefix: '/prompts', label: 'Prompts', placeholder: 'Search prompts…' },
  { prefix: '/webhooks', label: 'Webhooks', placeholder: 'Search webhooks…' },
  { prefix: '/audit', label: 'Audit log', placeholder: 'Search events…' },
  { prefix: '/settings', label: 'Settings' },
];

let searchEl: HTMLInputElement | null = $state(null);

const section = $derived(SECTIONS.find((entry) => page.url.pathname.startsWith(entry.prefix)) ?? SECTIONS[0]);

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    searchEl?.focus();
  }
}
</script>

<svelte:window onkeydown={onKeydown} />

<header
	class="flex h-[57px] flex-none items-center gap-4 border-b border-line bg-surface-1/70 px-6 backdrop-blur-lg"
>
	<div class="flex items-center gap-[7px] text-[13px] text-zinc-500">
		<span>Developers</span>
		<span class="text-zinc-700">/</span>
		<span class="font-medium text-zinc-200">{section.label}</span>
	</div>
	{#if section.placeholder}
		<div
			class="ml-auto flex h-[34px] w-[248px] items-center gap-2 rounded-lg border border-line-strong bg-surface-3 px-3 text-zinc-600 focus-within:border-emerald-500 focus-within:shadow-[0_0_0_3px_rgba(16,185,129,.12)]"
		>
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.7" stroke="currentColor" stroke-width="1.4" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			<input
				bind:this={searchEl}
				bind:value={dashboard.search}
				placeholder={section.placeholder}
				class="w-full bg-transparent text-[13px] tracking-[-0.01em] text-zinc-200 outline-none placeholder:text-zinc-600"
			/>
			<span class="rounded border border-zinc-800 px-[5px] py-px text-[10.5px] text-zinc-600">⌘K</span>
		</div>
	{/if}
</header>
