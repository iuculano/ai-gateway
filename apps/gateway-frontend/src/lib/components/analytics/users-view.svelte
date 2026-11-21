<script lang="ts">
import UsersIcon from '@lucide/svelte/icons/users';
import { type AnalyticsInterval, fetchUsers, type UsersResponse } from '#lib/api/analytics.ts';
import { windowOf } from '#lib/components/analytics/analytics-filters.svelte.ts';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import { Input } from '#lib/components/ui/input/index.ts';
import { fmt, fmtSpend } from '#lib/data/format.ts';
import { type User, type UserSort, userMeasure } from '#lib/data/users.ts';
import { Latest } from '#lib/state/latest.svelte.ts';
import { goto } from '$app/navigation';
import UserPane from './user-pane.svelte';

interface Props {
  days: number;
  interval: AnalyticsInterval;
  actorId?: string;
  userId?: string;
}

let { days, interval, actorId, userId }: Props = $props();

// Users per page of the list.
const PAGE = 50;

const SORTS = [
  { id: 'spend', label: 'Spend' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'requests', label: 'Requests' },
] satisfies { id: UserSort; label: string }[];

interface UserList {
  summary: UsersResponse;
  users: User[];
  range: { start_date: string; end_date: string };
  scope: string;
}

const list = new Latest<UserList>();
let loadingMore = $state(false);

// What the list is ordered by, and shows next to each user.
let sort = $state<UserSort>('spend');

// Any user can be looked up by id, and not only the ones listed.
let lookup = $state('');

async function fetchList(): Promise<UserList> {
  const range = windowOf(days);
  const scope = `${days}:${actorId ?? ''}`;
  const response = await fetchUsers({ ...range, actor_id: actorId, limit: PAGE, sort: sort });
  const shown = list.value;

  // The percentiles are an estimate that shifts with the list's order, so a
  // re-sort keeps the ones already shown.
  const summary = shown?.scope === scope ? { ...response, cost_percentiles: shown.summary.cost_percentiles } : response;

  return { summary: summary, users: response.users, range: range, scope: scope };
}

function load(): void {
  void list.load(fetchList);
}

/**
 * Adds the next page of users to the end of the list.
 */
async function loadMore(): Promise<void> {
  const shown = list.value;

  if (!shown) {
    return;
  }

  loadingMore = true;

  try {
    const response = await fetchUsers({
      ...shown.range,
      actor_id: actorId,
      limit: PAGE,
      offset: shown.users.length,
      sort: sort,
    });

    // A list loaded again in the meantime has no place for this page.
    if (list.value === shown) {
      list.value = { ...shown, users: [...shown.users, ...response.users] };
    }
  } catch {
    // The list keeps what it has and the button stays, so it can be tried
    // again.
  } finally {
    loadingMore = false;
  }
}

$effect(() => {
  void [days, actorId, sort];
  load();
});

const loading = $derived(list.loading);
const failed = $derived(list.error !== null);
const summary = $derived(list.value?.summary ?? null);
const users = $derived(list.value?.users ?? []);

/**
 * This tab's URL with a user picked, or with everyone, keeping any narrowing
 * to one app.
 */
function usersHref(user: string | null): string {
  const params = new URLSearchParams();

  if (actorId) {
    params.set('actor', actorId);
  }

  if (user) {
    params.set('user', user);
  }

  const query = params.toString();

  return query ? `/analytics/users?${query}` : '/analytics/users';
}

function openUser(event: SubmitEvent): void {
  event.preventDefault();

  const user = lookup.trim();

  if (user) {
    void goto(usersHref(user), { reset: false });
  }
}

// A user found by search, or linked to, may not be on the pages loaded so far.
const unlisted = $derived(userId !== undefined && !users.some((user) => user.user_id === userId));
const topMeasure = $derived(users[0] ? userMeasure(users[0], sort) : 0);
</script>

<div class="grid grid-cols-1 gap-[var(--analytics-gap)] lg:grid-cols-[300px_minmax(0,1fr)]">
	<!-- Side by side, the list is exactly as tall as the pane and scrolls within
	     it. The wrapper stretches to the row, which the pane sets, and the list
	     fills the wrapper without adding to it. Stacked, it gets a fixed cap. -->
	<div class="relative min-h-[320px]">
	<nav aria-label="Users" class="flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-track bg-surface-1 lg:absolute lg:inset-0 lg:max-h-none">
		<form onsubmit={openUser} class="flex flex-col gap-2 border-b border-line p-2.5">
			<Input
				bind:value={lookup}
				placeholder="Find a user id…"
				aria-label="Find a user by id"
				class="h-8 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-300"
			/>
			<FilterTabs tabs={SORTS} bind:value={sort} fill />
		</form>

		<div class="flex min-h-0 flex-col overflow-y-auto p-1.5">
			<!-- Styled as a button, like the sort control above it, because it is how
			     to get back to everyone. It is flex-none, or the scrolling list
			     squeezes it below its height. -->
			<a
				href={usersHref(null)}
				data-sveltekit-reset="false"
				aria-current={userId === undefined ? 'page' : undefined}
				class="flex h-9 flex-none items-center justify-between gap-3 rounded-lg border px-3 {userId === undefined
					? 'border-line-strong bg-seg text-zinc-50 shadow-[0_1px_2px_rgba(0,0,0,.3)]'
					: 'border-line-strong bg-surface-3 text-zinc-300 hover:bg-surface-4 hover:text-zinc-100'}"
			>
				<span class="flex items-center gap-2 text-[12.5px] font-medium"><UsersIcon class="size-3.5" />All users</span>
				<span class="text-[12px] text-zinc-500 tabular-nums">{summary ? fmt(summary.active_users) : '—'}</span>
			</a>

			{#if unlisted && userId}
				<a
					href={usersHref(userId)}
					data-sveltekit-reset="false"
					aria-current="page"
					class="mt-1 flex items-center justify-between gap-3 rounded-md bg-surface-6 px-2.5 py-2"
				>
					<span class="truncate font-mono text-[12px] text-zinc-100" title={userId}>{userId}</span>
					<span class="text-[11px] text-zinc-500">searched</span>
				</a>
			{/if}

			<div class="mx-2.5 my-1.5 border-t border-line"></div>

			{#if loading}
				<div class="py-8 text-center text-[12.5px] text-zinc-600">Loading users…</div>
			{:else if failed}
				<div class="flex flex-col items-center gap-2 py-6 text-[12.5px] text-zinc-500" role="status">
					Couldn't load users.
					<ToolbarButton onclick={load}>Retry</ToolbarButton>
				</div>
			{:else}
				{#each users as user (user.user_id)}
					{@const on = user.user_id === userId}
					<a
						href={usersHref(user.user_id)}
						data-sveltekit-reset="false"
						aria-current={on ? 'page' : undefined}
						class="flex flex-col gap-1 rounded-md px-2.5 py-1.5 {on ? 'bg-surface-6' : 'hover:bg-surface-4'}"
					>
						<span class="flex items-baseline justify-between gap-3">
							<span class="truncate font-mono text-[12px] {on ? 'text-zinc-100' : 'text-zinc-300'}" title={user.user_id}>{user.user_id}</span>
							<span class="flex-none text-[12px] text-zinc-300 tabular-nums">{sort === 'spend' ? fmtSpend(user.cost_total) : fmt(userMeasure(user, sort))}</span>
						</span>
						<span class="h-[2px] w-full rounded-full bg-surface-4">
							<span class="block h-full rounded-full bg-emerald-500/70" style:width={`${topMeasure > 0 ? (userMeasure(user, sort) / topMeasure) * 100 : 0}%`}></span>
						</span>
					</a>
				{:else}
					<div class="px-2.5 py-6 text-[12.5px] text-zinc-600">
						No requests tagged with a user. Send <code class="text-zinc-400">ai-log-tags: user_id:…</code> or the OpenAI <code class="text-zinc-400">user</code> field.
					</div>
				{/each}

				{#if summary && users.length < summary.active_users}
					<div class="px-2.5 py-2">
						<ToolbarButton onclick={loadMore} disabled={loadingMore}>
							{loadingMore ? 'Loading…' : `Show more (${fmt(summary.active_users - users.length)} left)`}
						</ToolbarButton>
					</div>
				{/if}
			{/if}
		</div>

	</nav>
	</div>

	<UserPane {userId} {actorId} {days} {interval} activeUsers={summary?.active_users ?? null}
		costPercentiles={summary?.cost_percentiles ?? null} />
</div>
