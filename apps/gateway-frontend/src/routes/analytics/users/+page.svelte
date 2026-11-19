<script lang="ts">
import { page } from '$app/state';
import { getAnalyticsFilters } from '$lib/components/analytics/analytics-filters.svelte';
import UsersView from '$lib/components/analytics/users-view.svelte';

const filters = getAnalyticsFilters();
// ?actor= narrows the list to one caller's users; ?user= opens one user under
// it. Both are linked to from the overview and from this tab's own lists.
const actorId = $derived(page.url.searchParams.get('actor') ?? undefined);
const userId = $derived(page.url.searchParams.get('user') ?? undefined);
</script>

<UsersView days={filters.range.days} interval={filters.range.interval} {actorId} {userId} />
