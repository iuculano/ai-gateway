<script lang="ts">
import { toast } from 'svelte-sonner';
import { getApiKeyStats } from '$lib/api/api-keys';
import type { ApiKey, ApiKeyStats } from '$lib/api/types';
import ConfirmDialog from '$lib/components/app/confirm-dialog.svelte';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import { Switch } from '$lib/components/ui/switch';
import { formatDate, initialsOf, timeAgo, timeUntil } from '$lib/data/format';
import { SCOPE_OPTIONS } from '$lib/data/scopes';
import { dashboard } from '$lib/state/dashboard.svelte';

let {
  apiKey,
  cols,
  expanded,
  ontoggle,
}: {
  apiKey: ApiKey;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
} = $props();

const TONES = ['#10b981', '#60a5fa', '#c084fc', '#f59e0b', '#34d399'];

const k = $derived(apiKey);
const revoked = $derived(k.revoked_at !== null);
const expired = $derived(!revoked && k.expires_at !== null && new Date(k.expires_at) <= new Date());
const status = $derived(
  revoked
    ? { label: 'Revoked', color: '#71717a', glow: 'transparent' }
    : expired
      ? { label: 'Expired', color: '#f59e0b', glow: 'rgba(245,158,11,.5)' }
      : { label: 'Active', color: '#10b981', glow: 'rgba(16,185,129,.6)' },
);
const tone = $derived(
  revoked ? '#52525b' : TONES[[...k.id].reduce((acc, char) => acc + char.charCodeAt(0), 0) % TONES.length],
);
// Scopes travel space-delimited; the UI works with the array form.
const scopeList = $derived(k.scopes.split(' ').filter(Boolean));

const detailItems: DetailItem[] = $derived([
  { label: 'Key ID', value: k.id },
  { label: 'Created', value: formatDate(k.created_at), mono: false },
  { label: 'Created by', value: k.creator_id ?? '—' },
]);

let busy = $state(false);
let confirmRevokeOpen = $state(false);
let confirmDeleteOpen = $state(false);

// Usage counters live in redis, behind their own endpoint - the list response
// carries none of this. Fetched on first expand rather than with the page, so
// a table of 50 keys does not fire 50 extra requests for figures nobody has
// asked to see.
let stats: ApiKeyStats | null = $state(null);
let statsLoading = $state(false);
let statsLoaded = $state(false);
let statsError: string | null = $state(null);

async function loadStats() {
  if (statsLoaded || statsLoading) return;
  statsLoading = true;
  statsError = null;

  try {
    stats = await getApiKeyStats(k.id);
    statsLoaded = true;
  } catch (error) {
    statsError = error instanceof Error ? error.message : 'Failed to load usage.';
  } finally {
    statsLoading = false;
  }
}

$effect(() => {
  if (expanded) loadStats();
});

/**
 * How much of the current window is spent, as a percentage.
 *
 * Guarded against a zero limit so a misconfigured key renders an empty bar
 * rather than NaN.
 */
const windowPercent = $derived.by(() => {
  const w = stats?.current_window;
  if (!w || w.limit <= 0) return 0;
  return Math.min(100, Math.round((w.used / w.limit) * 100));
});

/**
 * The four current_window fields, formatted for display.
 *
 * current_window comes back null in two cases: a key with no limit configured,
 * and a limited key whose counter is not ticking right now. Neither has
 * anything to read out of redis, but rendering nothing leaves the panel
 * looking broken - so fall back to what the key's own configuration already
 * says. An unlimited key can never consume a window, and a limited key with no
 * live counter has spent nothing of its next one.
 */
const windowView = $derived.by(() => {
  const w = stats?.current_window;
  if (w) {
    return {
      used: w.used.toLocaleString(),
      remaining: w.remaining.toLocaleString(),
      limit: w.limit.toLocaleString(),
      resets: `in ${timeUntil(w.resets_at)}`,
      resetsTitle: w.resets_at,
    };
  }

  const limit = k.rate_limit_requests;
  if (limit === null) {
    return { used: '—', remaining: '∞', limit: 'Unlimited', resets: '—', resetsTitle: undefined };
  }

  // Dashes until the stats call answers - '0 used' is a claim about redis, and
  // it must not be made before redis has been asked.
  return {
    used: statsLoaded ? '0' : '—',
    remaining: statsLoaded ? limit.toLocaleString() : '—',
    limit: limit.toLocaleString(),
    resets: '—',
    resetsTitle: undefined,
  };
});

async function toggleScope(scopeId: string, on: boolean) {
  // Drop scope names the backend no longer recognizes (keys created before
  // scope validation existed) - resending them would fail the whole update.
  const known = new Set(SCOPE_OPTIONS.map((s) => s.id));
  const current = scopeList.filter((s) => known.has(s));

  const next = on ? [...current, scopeId] : current.filter((s) => s !== scopeId);
  busy = true;
  try {
    await dashboard.setScopes(k.id, next);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to update scopes.');
  } finally {
    busy = false;
  }
}

async function revoke() {
  busy = true;
  try {
    await dashboard.revoke(k.id);
    toast.success('Key revoked');
    confirmRevokeOpen = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to revoke key.');
  } finally {
    busy = false;
  }
}

async function remove() {
  busy = true;
  try {
    await dashboard.remove(k.id);
    toast.success('Key deleted');
    confirmDeleteOpen = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to delete key.');
  } finally {
    busy = false;
  }
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<div class="flex min-w-0 items-center gap-[11px]">
			<div
				class="flex size-8 flex-none items-center justify-center rounded-[9px] text-xs font-semibold"
				style:background={revoked ? '#161618' : tone + '1f'}
				style:color={revoked ? '#52525b' : tone}
			>
				{initialsOf(k.name)}
			</div>
			<div class="flex min-w-0 flex-col leading-[1.3]">
				<span class="overflow-hidden text-[13.5px] font-medium text-ellipsis whitespace-nowrap">{k.name}</span>
				<span class="overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap text-zinc-600">
					{scopeList.length} scope{scopeList.length === 1 ? '' : 's'}
				</span>
			</div>
		</div>
		<span class="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-zinc-400">
			{k.description ?? '—'}
		</span>
		<span class="text-[13px] text-zinc-400">{formatDate(k.created_at)}</span>
		<!-- The list response hydrates this from redis. The em dash is for the
		     rows that reach this table by another route - a freshly updated key
		     carries no count of its own - not for a key that has never been used,
		     which is a real 0. -->
		<span class="text-right text-[13px] text-zinc-400 tabular-nums">
			{k.total_requests === undefined ? '—' : k.total_requests.toLocaleString()}
		</span>
		<span class="inline-flex items-center gap-1.5 text-xs font-medium" style:color={status.color}>
			<span
				class="size-1.5 rounded-full"
				style:background={status.color}
				style:box-shadow="0 0 6px {status.glow}"
			></span>{status.label}
		</span>
		<div class="flex items-center justify-end gap-1.5">
			<button
				type="button"
				class="h-7 rounded-md border border-red-500/30 bg-red-500/8 px-2.5 text-[11.5px] font-semibold text-red-400 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-surface-3 disabled:text-zinc-600"
				disabled={revoked || busy}
				onclick={(e) => {
					e.stopPropagation();
					confirmRevokeOpen = true;
				}}
			>
				Revoke
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-semibold text-zinc-300 hover:bg-surface-4 disabled:opacity-50"
				disabled={busy}
				onclick={(e) => {
					e.stopPropagation();
					confirmDeleteOpen = true;
				}}
			>
				Delete
			</button>
		</div>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={3} />

		<!-- Side by side: lifetime counters on one side, the ceiling and the live
		     window counting against it on the other. Both boxes take the height of
		     the taller (the grid's default stretch), and Usage - which has only two
		     figures against the other's six - centres its row in the space rather
		     than leaving it hanging under the header. -->
		<div class="grid grid-cols-2 gap-3.5">
			<Panel title="Usage">
				{#if statsLoading}
					<div class="flex grow items-center px-3.5 py-[13px] text-[12.5px] text-zinc-600">Loading usage…</div>
				{:else if statsError}
					<div class="flex grow items-center px-3.5 py-[13px] text-[12.5px] text-red-400">{statsError}</div>
				{:else if stats}
					<div class="flex grow items-center gap-8 px-3.5 py-[13px]">
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Total requests</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums">
								{stats.total_requests.toLocaleString()}
							</div>
						</div>
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Last used</div>
							<div class="text-[13px] font-medium text-zinc-200" title={stats.last_used_at ?? undefined}>
								{timeAgo(stats.last_used_at)}
							</div>
						</div>
					</div>
				{/if}
			</Panel>

			<Panel title="Limits">
				<div class="flex gap-8 px-3.5 py-[13px]">
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Rate limit</div>
						<div class="text-[13px] font-medium text-zinc-200">
							{k.rate_limit_requests === null
								? 'Unlimited'
								: `${k.rate_limit_requests.toLocaleString()} / ${k.rate_limit_window}s`}
						</div>
					</div>
					<div>
						<div class="mb-0.5 text-[10.5px] text-zinc-600">Expires</div>
						<div class="text-[13px] font-medium text-zinc-200">
							{k.expires_at === null ? 'Never' : formatDate(k.expires_at)}
						</div>
					</div>
				</div>

				<!-- Every field the stats endpoint returns for the live window. Always
				     rendered: windowView falls back to the key's own configuration when
				     nothing is counting, so the section never collapses to nothing. The
				     Usage panel alongside carries the loading and error states. -->
				<div class="border-t border-line px-3.5 py-[13px]">
					<div class="mb-2.5 text-[10.5px] text-zinc-600">Current rate limit window</div>
					<div class="grid grid-cols-2 gap-x-8 gap-y-3">
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Used</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums">{windowView.used}</div>
						</div>
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Remaining</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums">{windowView.remaining}</div>
						</div>
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Limit</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums">{windowView.limit}</div>
						</div>
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Resets</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums" title={windowView.resetsTitle}>
								{windowView.resets}
							</div>
						</div>
					</div>
					{#if k.rate_limit_requests !== null}
						<div class="mt-3 h-1 overflow-hidden rounded-sm bg-zinc-800">
							<div
								class="h-full rounded-sm {windowPercent >= 90 ? 'bg-red-400' : 'bg-emerald-500'}"
								style:width="{windowPercent}%"
							></div>
						</div>
					{/if}
				</div>
			</Panel>
		</div>

		<Panel title="Permissions &amp; scopes">
			<div class="flex flex-col gap-px bg-line">
				{#each SCOPE_OPTIONS as scope (scope.id)}
					<div class="flex items-center gap-[11px] bg-surface-2 px-[13px] py-2.5">
						<div class="flex-1 leading-[1.3]">
							<span class="text-[13px] font-medium text-zinc-200">{scope.label}</span>
							<span class="ml-2.5 text-[11.5px] text-zinc-600">{scope.desc}</span>
						</div>
						<Switch
							checked={scopeList.includes(scope.id)}
							disabled={revoked || busy}
							onCheckedChange={(on) => toggleScope(scope.id, on)}
							class="h-5 w-9 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-zinc-800"
						/>
					</div>
				{/each}
			</div>
		</Panel>
	{/snippet}
</ExpandableRow>

<ConfirmDialog
		bind:open={confirmRevokeOpen}
		title="Revoke this API key?"
		description="'{k.name}' will stop working immediately for any application using it. This cannot be undone, but the key stays in your audit history."
		confirmLabel="Revoke key"
		tone="danger"
		{busy}
		onconfirm={revoke}
	/>

	<ConfirmDialog
		bind:open={confirmDeleteOpen}
		title="Delete this API key?"
		description="'{k.name}' will be permanently removed. This cannot be undone."
		confirmLabel="Delete key"
		tone="danger"
		{busy}
		onconfirm={remove}
	/>
