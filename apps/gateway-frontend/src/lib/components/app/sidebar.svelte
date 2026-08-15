<script lang="ts">
import { page } from '$app/state';
import { initialsOf } from '$lib/data/format';
import { dashboard } from '$lib/state/dashboard.svelte';

let { user }: { user?: { name?: string; email?: string; username?: string } } = $props();

const displayName = $derived(user?.name ?? user?.username ?? 'Unknown user');

const isActive = (href: string) => page.url.pathname.startsWith(href);

const itemClass = (active: boolean) =>
  active
    ? 'flex w-full items-center gap-2.5 rounded-[7px] bg-surface-5 px-2.5 py-[7px] font-medium text-zinc-50 shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
    : 'flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-zinc-400 hover:bg-surface-4 hover:text-zinc-200';
</script>

<aside class="flex w-[236px] flex-none flex-col border-r border-line bg-surface-1">
	<div class="flex h-[57px] flex-none items-center gap-2.5 border-b border-line px-[18px]">
		<div
			class="flex size-[26px] items-center justify-center rounded-[7px] bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-[0_0_0_1px_rgba(16,185,129,.25),0_2px_8px_rgba(16,185,129,.25)]"
		>
			<div class="size-[9px] rounded-full border-2 border-[#04130d]"></div>
		</div>
		<div class="flex flex-col leading-[1.1]">
			<span class="text-[13.5px] font-semibold">Relay</span>
			<span class="text-[10.5px] text-[#5b5b63]">API Platform</span>
		</div>
	</div>

	<nav class="flex flex-1 flex-col gap-px overflow-auto p-3">
		<div class="px-2.5 pt-2 pb-[5px] text-[10.5px] font-medium tracking-[.06em] text-zinc-600 uppercase">
			Platform
		</div>

		<button type="button" class={itemClass(false)}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.3" stroke="currentColor" stroke-width="1.4" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.3" stroke="currentColor" stroke-width="1.4" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.3" stroke="currentColor" stroke-width="1.4" /><rect x="9" y="9" width="5.5" height="5.5" rx="1.3" stroke="currentColor" stroke-width="1.4" /></svg>
			<span>Overview</span>
		</button>

		<a href="/keys" class={itemClass(isActive('/keys'))}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="8" r="3" stroke="#10b981" stroke-width="1.4" /><path d="M7.8 8H14.5M11.5 8v2.4M13.4 8v1.8" stroke="#10b981" stroke-width="1.4" stroke-linecap="round" /></svg>
			<span>API Keys</span>
			{#if dashboard.keys.length > 0}
				<span class="ml-auto rounded-[5px] bg-emerald-500/12 px-1.5 py-px text-[10.5px] font-medium text-emerald-500">
					{dashboard.keys.length}
				</span>
			{/if}
		</a>

		<a href="/logs" class={itemClass(isActive('/logs'))}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M1.8 8h2.6l1.5-3.6 2.3 7.2 1.6-4.3 1.1 2.1h3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
			<span>Logs</span>
		</a>

		<a href="/analytics" class={itemClass(isActive('/analytics'))}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 14V2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><rect x="4" y="8" width="2.6" height="4.5" rx=".8" fill="currentColor" /><rect x="7.7" y="5" width="2.6" height="7.5" rx=".8" fill="currentColor" /><rect x="11.4" y="2.5" width="2.6" height="10" rx=".8" fill="currentColor" /></svg>
			<span>Analytics</span>
		</a>

		<button type="button" class={itemClass(false)}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.4" /><path d="M8 8L11 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			<span>Rate Limits</span>
		</button>

		<a href="/audit" class={itemClass(isActive('/audit'))}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" /><path d="M4.3 6h7.4M4.3 8.4h7.4M4.3 10.8h4.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
			<span>Audit Log</span>
		</a>

		<button type="button" class={itemClass(false)}>
			<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.4" stroke="currentColor" stroke-width="1.4" /><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
			<span>Settings</span>
		</button>
	</nav>

	<div class="border-t border-line p-3">
		<a
			href="/auth/logout"
			title="Sign out"
			class="flex w-full items-center gap-2.5 rounded-lg p-2 hover:bg-surface-4"
		>
			<div
				class="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 text-[11px] font-semibold text-zinc-300"
			>
				{initialsOf(displayName)}
			</div>
			<div class="flex min-w-0 flex-col text-left leading-[1.2]">
				<span class="overflow-hidden text-[12.5px] font-medium text-ellipsis whitespace-nowrap">
					{displayName}
				</span>
				<span class="overflow-hidden text-[10.5px] text-ellipsis whitespace-nowrap text-[#5b5b63]">
					{user?.email ?? ''}
				</span>
			</div>
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="ml-auto flex-none"><path d="M5 6.5L8 9.5L11 6.5" stroke="#71717a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
		</a>
	</div>
</aside>
