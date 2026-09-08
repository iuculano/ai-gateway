<script lang="ts">
import { page } from '$app/state';
import { dashboard } from '$lib/state/dashboard.svelte';

let searchEl: HTMLInputElement | null = $state(null);

/**
 * The breadcrumb and the search box's placeholder, per section.
 *
 * A table rather than the ternary this used to be: that resolved every path
 * that was not /audit to 'API Keys', so /logs and /analytics had been sitting
 * under the wrong crumb, and a fourth section would have made a third branch.
 * Keys first, since it is also the fallback for anything unlisted.
 */
const SECTIONS = [
  { prefix: '/keys', label: 'API Keys', placeholder: 'Search keys…' },
  { prefix: '/logs', label: 'Logs', placeholder: 'Search logs…' },
  { prefix: '/traces', label: 'Traces', placeholder: 'Search trace names, IDs and tags…' },
  { prefix: '/models', label: 'Models', placeholder: 'Search providers and models…' },
  { prefix: '/overview', label: 'Overview', placeholder: 'Search…' },
  { prefix: '/playground', label: 'Playground', placeholder: 'Search…' },
  { prefix: '/analytics', label: 'Analytics', placeholder: 'Search…' },
  { prefix: '/prompts', label: 'Prompts', placeholder: 'Search prompts…' },
  { prefix: '/webhooks', label: 'Webhooks', placeholder: 'Search webhooks…' },
  { prefix: '/audit', label: 'Audit log', placeholder: 'Search events…' },
  { prefix: '/settings', label: 'Settings', placeholder: 'Search…' },
];

const section = $derived(SECTIONS.find((s) => page.url.pathname.startsWith(s.prefix)) ?? SECTIONS[0]);

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
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
	<div class="ml-auto flex items-center gap-3">
		<div
			class="flex h-[34px] w-[248px] items-center gap-2 rounded-lg border border-line-strong bg-surface-3 px-3 text-zinc-600 focus-within:border-emerald-500 focus-within:shadow-[0_0_0_3px_rgba(16,185,129,.12)]"
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
		<div class="h-[22px] w-px bg-line-strong"></div>
		<button
			type="button"
			class="relative flex size-[34px] items-center justify-center rounded-lg border border-line-strong bg-surface-3 hover:bg-surface-4"
			aria-label="Notifications"
		>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2a3.5 3.5 0 00-3.5 3.5c0 3-1.3 4-1.3 4h9.6s-1.3-1-1.3-4A3.5 3.5 0 008 2zM6.6 13a1.5 1.5 0 002.8 0" stroke="#a1a1aa" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
			<span
				class="absolute top-2 right-[9px] size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_2px_var(--color-surface-3)]"
			></span>
		</button>
	</div>
</header>
