<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import { resolveActorNames } from '$lib/api/actors';
import { getApiKeyStats } from '$lib/api/api-keys';
import type { ApiKey, ApiKeyStats } from '$lib/api/types';
import ConfirmDialog from '$lib/components/app/confirm-dialog.svelte';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import CreateKeyDialog from '$lib/components/keys/create-key-dialog.svelte';
import { fmtTs, formatDate, timeUntil } from '$lib/data/format';
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
const sortedScopes = $derived([
  ...SCOPE_OPTIONS.filter((scope) => scopeList.includes(scope.id)),
  ...SCOPE_OPTIONS.filter((scope) => !scopeList.includes(scope.id)),
]);

let creatorName: string | null = $state(null);
let revokerName: string | null = $state(null);

$effect(() => {
  const creatorId = k.creator_id;
  const revokerId = k.revoked_by;
  if (!expanded) return;
  let cancelled = false;
  creatorName = null;
  revokerName = null;
  const creator = { actor_type: 'user', actor_id: creatorId };
  const revoker = { actor_type: 'user', actor_id: revokerId };
  resolveActorNames([creator, revoker])
    .then((name) => {
      if (cancelled) return;
      creatorName = creatorId ? name(creator) : null;
      revokerName = revokerId ? name(revoker) : null;
    })
    .catch(() => {
      // Keep the user IDs visible if name resolution is unavailable.
    });
  return () => {
    cancelled = true;
  };
});

const detailItems: DetailItem[] = $derived([
  {
    label: 'Key ID',
    value: k.id,
    title: k.id,
    copyable: true,
    auditHref: `/audit?target_type=api_key&target_id=${encodeURIComponent(k.id)}`,
  },
  { label: 'Created', value: fmtTs(new Date(k.created_at).toISOString()).full, mono: false },
  { label: 'Created by', value: creatorName ?? k.creator_id ?? '—', title: k.creator_id ?? undefined, mono: false },
  {
    label: 'Last updated',
    value: fmtTs(new Date(k.updated_at).toISOString()).full,
    title: fmtTs(new Date(k.updated_at).toISOString()).full,
    mono: false,
  },
]);

const revocationItems: DetailItem[] = $derived([
  { label: 'Revoked', value: k.revoked_at ? fmtTs(new Date(k.revoked_at).toISOString()).full : '—', mono: false },
  {
    label: 'Revoked by',
    value: revoked ? (revokerName ?? k.revoked_by ?? 'Unknown user') : '—',
    title: k.revoked_by ?? undefined,
    mono: false,
  },
]);

let busy = $state(false);
let confirmRevokeOpen = $state(false);
let editOpen = $state(false);

// Usage counters live in redis, behind their own endpoint - the list response
// carries none of this. Fetched on first expand rather than with the page, so
// a table of 50 keys does not fire 50 extra requests for figures nobody has
// asked to see.
let stats: ApiKeyStats | null = $state(null);
let statsLoading = $state(false);
let statsLoaded = $state(false);
let statsError: string | null = $state(null);

let statsRequest = 0;

async function loadStats(force = false) {
  if (!force && (statsLoaded || statsLoading)) return;
  const request = ++statsRequest;
  statsLoading = true;
  statsError = null;

  try {
    const result = await getApiKeyStats(k.id);
    if (request !== statsRequest) return;
    stats = result;
    statsLoaded = true;
  } catch (error) {
    if (request !== statsRequest) return;
    statsError = error instanceof Error ? error.message : 'Failed to load usage.';
  } finally {
    if (request === statsRequest) statsLoading = false;
  }
}

$effect(() => {
  if (expanded) {
    // Only expansion triggers loading; failures remain idle until an explicit retry.
    untrack(() => {
      if (!statsError) void loadStats();
    });
  }
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
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<!-- A tone dot rather than an initials block. The 32px avatar was the
			     tallest thing in the row and set the row height on its own; this keeps
			     the same deterministic colour at the height logs' rows run at. -->
			<span
				class="size-[7px] flex-none rounded-full"
				style:background={revoked ? '#52525b' : tone}
			></span>
			<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{k.name}</span>
		</span>

		<!-- Lifted out from under the name, where it made every row two lines tall. -->
		<span class="text-[12.5px] whitespace-nowrap text-zinc-500">
			{scopeList.length} scope{scopeList.length === 1 ? '' : 's'}
		</span>
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-400">
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
				class="h-7 rounded-md border border-line-strong bg-surface-3 px-2.5 text-[11.5px] font-semibold text-zinc-300 hover:bg-surface-4 disabled:cursor-not-allowed disabled:opacity-50"
				disabled={revoked || busy}
				onclick={(event) => {
					event.stopPropagation();
					editOpen = true;
				}}
			>
				Edit
			</button>
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
		</div>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={[...detailItems, ...revocationItems]} cols={6} />

		<div class="grid gap-3.5 md:grid-cols-2">
			<Panel title="Usage &amp; limits">
				{#if statsLoading}
					<div class="flex min-h-[65px] items-center px-3.5 py-[13px] text-[12.5px] text-zinc-600">Loading usage…</div>
				{:else if statsError}
					<div class="flex min-h-[65px] items-center gap-3 px-3.5 py-[13px]">
						<span class="text-[12.5px] text-red-400">{statsError}</span>
						<ToolbarButton onclick={() => void loadStats()}>Retry usage</ToolbarButton>
					</div>
				{:else if stats}
					<div class="grid grid-cols-2 gap-8 px-3.5 py-[13px]">
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Total requests</div>
							<div class="text-[13px] font-medium text-zinc-200 tabular-nums">
								{stats.total_requests.toLocaleString()}
							</div>
						</div>
						<div>
							<div class="mb-0.5 text-[10.5px] text-zinc-600">Last used</div>
							<div class="text-[13px] font-medium text-zinc-200" title={stats.last_used_at ?? undefined}>
								{stats.last_used_at === null ? 'Never' : fmtTs(new Date(stats.last_used_at).toISOString()).full}
							</div>
						</div>
					</div>
				{/if}
				<div class="grid grid-cols-2 gap-8 border-t border-line px-3.5 py-[13px]">
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
							{k.expires_at === null ? 'Never' : fmtTs(new Date(k.expires_at).toISOString()).full}
						</div>
					</div>
				</div>

				<!-- Every field the stats endpoint returns for the live window. Always
				     rendered: windowView falls back to the key's own configuration when
				     nothing is counting, so the section never collapses to nothing. The
				     Usage section above carries the loading and error states. -->
				<div class="px-3.5 py-[13px]">
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
				</div>
			</Panel>

			<Panel title="Permissions &amp; scopes">
				<!-- The list takes the adjacent panel's height without stretching the row. -->
				<div class="grid max-h-80 flex-1 grid-cols-[max-content_minmax(0,1fr)_max-content] content-start gap-x-3 overflow-y-auto overscroll-contain px-[13px] md:max-h-none md:[contain:size]">
					{#each sortedScopes as scope (scope.id)}
						<div class="col-span-3 grid grid-cols-subgrid items-center border-b border-line py-2.5 last:border-b-0">
							<span class="whitespace-nowrap text-[13px] font-medium text-zinc-200">{scope.label}</span>
							<span class="min-w-0 truncate text-[11.5px] text-zinc-500" title={scope.desc}>{scope.desc}</span>
							<span class="text-right text-[11.5px] font-medium {scopeList.includes(scope.id) ? 'text-emerald-400' : 'text-zinc-500'}">
								{scopeList.includes(scope.id) ? 'Enabled' : 'Disabled'}
							</span>
						</div>
					{/each}
				</div>
			</Panel>
		</div>
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

{#if editOpen}
	<CreateKeyDialog bind:open={editOpen} apiKey={k} onsaved={() => {
		stats = null;
		statsLoaded = false;
		statsError = null;
		if (expanded) void loadStats(true);
	}} />
{/if}
