<script lang="ts">
import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import { resolveActorNames } from '#lib/api/actors.ts';
import { getApiKeyStats } from '#lib/api/api-keys.ts';
import type { ApiKey, ApiKeyStats } from '#lib/api/types.ts';
import ConfirmDialog from '#lib/components/app/confirm-dialog.svelte';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import CreateKeyDialog from '#lib/components/keys/create-key-dialog.svelte';
import { keyStatus, rateWindow } from '#lib/data/api-keys.ts';
import { fmtTs, formatDate, toneFor } from '#lib/data/format.ts';
import { SCOPE_OPTIONS } from '#lib/data/scopes.ts';
import { dashboard } from '#lib/state/dashboard.svelte.ts';
import { Latest } from '#lib/state/latest.svelte.ts';

interface Props {
  apiKey: ApiKey;
  cols: string;
  expanded: boolean;
  ontoggle: () => void;
}

let { apiKey, cols, expanded, ontoggle }: Props = $props();

const STATUSES = {
  active: { label: 'Active', color: '#10b981', glow: 'rgba(16,185,129,.6)' },
  expired: { label: 'Expired', color: '#f59e0b', glow: 'rgba(245,158,11,.5)' },
  revoked: { label: 'Revoked', color: '#71717a', glow: 'transparent' },
};

const k = $derived(apiKey);
const revoked = $derived(k.revoked_at !== null);
const status = $derived(STATUSES[keyStatus(k, Date.now())]);
const tone = $derived(revoked ? '#52525b' : toneFor(k.id));

// Scopes travel as one string with spaces between them, and the row works with
// the list. The ones the key holds are shown first.
const scopeList = $derived(k.scopes.split(' ').filter(Boolean));
const sortedScopes = $derived([
  ...SCOPE_OPTIONS.filter((scope) => scopeList.includes(scope.id)),
  ...SCOPE_OPTIONS.filter((scope) => !scopeList.includes(scope.id)),
]);

let creatorName: string | null = $state(null);
let revokerName: string | null = $state(null);

let busy = $state(false);
let confirmRevokeOpen = $state(false);
let editOpen = $state(false);

// Usage counters live in the store behind their own endpoint, and the list
// response carries none of them. They are fetched when a row is first opened
// and not with the page, so that a table of 50 keys does not make 50 requests
// for figures nobody asked to see.
const usage = new Latest<ApiKeyStats>({ idle: true, failureMessage: 'Failed to load usage.' });
const stats = $derived(usage.value);

function fullTime(iso: string): string {
  return fmtTs(new Date(iso).toISOString()).full;
}

// The names behind the two user ids, looked up once the row is opened. When
// they cannot be resolved, the ids stay on show.
$effect(() => {
  const creatorId = k.creator_id;
  const revokerId = k.revoked_by;

  if (!expanded) {
    return;
  }

  const creator = { actor_type: 'user', actor_id: creatorId };
  const revoker = { actor_type: 'user', actor_id: revokerId };
  let cancelled = false;

  creatorName = null;
  revokerName = null;

  resolveActorNames([creator, revoker])
    .then((name) => {
      if (cancelled) {
        return;
      }

      creatorName = creatorId ? name(creator) : null;
      revokerName = revokerId ? name(revoker) : null;
    })
    .catch(() => {});

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
  { label: 'Created', value: fullTime(k.created_at), mono: false },
  { label: 'Created by', value: creatorName ?? k.creator_id ?? '—', title: k.creator_id ?? undefined, mono: false },
  { label: 'Last updated', value: fullTime(k.updated_at), title: fullTime(k.updated_at), mono: false },
  { label: 'Revoked', value: k.revoked_at ? fullTime(k.revoked_at) : '—', mono: false },
  {
    label: 'Revoked by',
    value: revoked ? (revokerName ?? k.revoked_by ?? 'Unknown user') : '—',
    title: k.revoked_by ?? undefined,
    mono: false,
  },
]);

function fetchStats(): Promise<ApiKeyStats> {
  return getApiKeyStats(k.id);
}

function loadStats(): void {
  void usage.load(fetchStats);
}

$effect(() => {
  if (!expanded) {
    return;
  }

  // Opening the row is the only thing that loads, and it loads once. A failure
  // waits for the retry button, so nothing in here is tracked.
  untrack(() => {
    if (usage.value === null && !usage.loading && usage.error === null) {
      loadStats();
    }
  });
});

const windowView = $derived(rateWindow(stats, k.rate_limit_requests));

/**
 * Loads the usage again after an edit, which can change the limit it is
 * counted against.
 */
function reloadStats(): void {
  usage.value = null;
  usage.error = null;

  if (expanded) {
    loadStats();
  }
}

// The row itself is a button, so its own buttons keep their clicks from
// toggling it.
function openEdit(event: MouseEvent): void {
  event.stopPropagation();
  editOpen = true;
}

function askToRevoke(event: MouseEvent): void {
  event.stopPropagation();
  confirmRevokeOpen = true;
}

async function revoke(): Promise<void> {
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
			<!-- A dot in the key's own colour and not an initials block, which would
			     be the tallest thing in the row and set its height. -->
			<span class="size-[7px] flex-none rounded-full" style:background={tone}></span>
			<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{k.name}</span>
		</span>

		<!-- Beside the name and not under it, which would make every row two lines tall. -->
		<span class="text-[12.5px] whitespace-nowrap text-zinc-500">
			{scopeList.length} scope{scopeList.length === 1 ? '' : 's'}
		</span>
		<span class="overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-zinc-400">
			{k.description ?? '—'}
		</span>
		<span class="text-[13px] text-zinc-400">{formatDate(k.created_at)}</span>
		<!-- The list response fills this in. The dash is for a row that reached the
		     table another way, such as a key that was just updated and carries no
		     count of its own. A key that has never been used shows a real 0. -->
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
				onclick={openEdit}
			>
				Edit
			</button>
			<button
				type="button"
				class="h-7 rounded-md border border-red-500/30 bg-red-500/8 px-2.5 text-[11.5px] font-semibold text-red-400 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-surface-3 disabled:text-zinc-600"
				disabled={revoked || busy}
				onclick={askToRevoke}
			>
				Revoke
			</button>
		</div>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} cols={6} />

		<div class="grid gap-3.5 md:grid-cols-2">
			<Panel title="Usage &amp; limits">
				{#if usage.loading}
					<div class="flex min-h-[65px] items-center px-3.5 py-[13px] text-[12.5px] text-zinc-600">Loading usage…</div>
				{:else if usage.error}
					<div class="flex min-h-[65px] items-center gap-3 px-3.5 py-[13px]">
						<span class="text-[12.5px] text-red-400">{usage.error}</span>
						<ToolbarButton onclick={loadStats}>Retry usage</ToolbarButton>
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
								{stats.last_used_at === null ? 'Never' : fullTime(stats.last_used_at)}
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
							{k.expires_at === null ? 'Never' : fullTime(k.expires_at)}
						</div>
					</div>
				</div>

				<!-- Every field the stats endpoint returns for the live window. It is
				     always rendered, because the view falls back to the key's own
				     settings when nothing is counting. The section above carries the
				     loading and error states. -->
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
	<CreateKeyDialog bind:open={editOpen} apiKey={k} onsaved={reloadStats} />
{/if}
