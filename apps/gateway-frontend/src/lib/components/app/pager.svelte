<script lang="ts">
import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import type { PagedList } from '#lib/state/paged-list.svelte.ts';

// The step back, the page number and the step forward under a paged table. The
// number stands alone, with no total. The endpoints page by cursor and have no
// count, so a total would have to be invented.

interface Props {
  list: Pick<PagedList<unknown>, 'pageIndex' | 'hasMore' | 'loading' | 'previousPage' | 'nextPage'>;

  /**
   * What the step back is called. A list in time order steps to newer rows.
   */
  previousLabel?: string;
  nextLabel?: string;
}

let { list, previousLabel = 'Newer', nextLabel = 'Older' }: Props = $props();
</script>

<div class="flex items-center justify-center gap-3">
	<ToolbarButton disabled={list.pageIndex === 0 || list.loading} onclick={() => list.previousPage()}>
		<ChevronLeftIcon class="size-[13px]" />
		{previousLabel}
	</ToolbarButton>
	<span class="min-w-[64px] text-center text-[12.5px] text-zinc-500">Page {list.pageIndex + 1}</span>
	<ToolbarButton disabled={!list.hasMore || list.loading} onclick={() => list.nextPage()}>
		{nextLabel}
		<ChevronRightIcon class="size-[13px]" />
	</ToolbarButton>
</div>
