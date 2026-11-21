<script lang="ts">
import { copyToClipboard } from '#lib/clipboard.ts';
import DetailGrid, { type DetailItem } from '#lib/components/app/detail-grid.svelte';
import ExpandableRow from '#lib/components/app/expandable-row.svelte';
import FilterTabs from '#lib/components/app/filter-tabs.svelte';
import Panel from '#lib/components/app/panel.svelte';
import ToolbarButton from '#lib/components/app/toolbar-button.svelte';
import type { AuditEvent } from '#lib/data/audit.ts';
import { fmtChangeValue, fmtTs, humanize, parseUA } from '#lib/data/format.ts';

interface Props {
  event: AuditEvent;
  cols: string;
  catColor: string;
  catLabel: string;
  expanded: boolean;
  ontoggle: () => void;
}

let { event, cols, catColor, catLabel, expanded, ontoggle }: Props = $props();

const ACTOR_TYPES: Record<string, string> = {
  unknown: 'Unknown',
  user: 'User',
  api_key: 'API key',
  system: 'System',
};

const VIEWS = [
  { id: 'diff' as const, label: 'Diff' },
  { id: 'json' as const, label: 'Metadata' },
];

let metaView: 'diff' | 'json' = $state('diff');

const e = $derived(event);
const occ = $derived(fmtTs(e.occurred_at ?? e.created_at));
const rec = $derived(fmtTs(e.created_at));
const statusColor = $derived(e.status === 'success' ? '#10b981' : '#f87171');
const statusLabel = $derived(e.status === 'success' ? 'Success' : 'Failure');
const actorTypeLabel = $derived(ACTOR_TYPES[e.actor_type] ?? e.actor_type);
const metaJson = $derived(JSON.stringify(e.metadata, null, 2));

const changes = $derived(
  Object.entries(e.metadata?.changes ?? {}).map(([field, change]) => ({
    field: humanize(field),
    from: fmtChangeValue(change.old) ?? '∅',
    to: fmtChangeValue(change.new) ?? '∅',
  })),
);
const hasChanges = $derived(changes.length > 0);

const detailItems: DetailItem[] = $derived([
  { label: 'Event ID', value: e.id },
  { label: 'Action', value: e.event },
  { label: 'Status', value: statusLabel, tone: statusColor, mono: false },
  { label: 'Request ID', value: e.request_id ?? '—' },
  { label: `Actor · ${actorTypeLabel}`, value: e.actorLabel, mono: false },
  { label: 'Target type', value: e.target_type ?? '—' },
  { label: 'Target ID', value: e.target_id ?? '—' },
  { label: 'Occurred at', value: occ.full },
  { label: 'Recorded at', value: rec.full },
  { label: 'IP address', value: e.ip ?? '—' },
  { label: 'User agent', value: parseUA(e.user_agent), mono: false, title: e.user_agent ?? undefined },
]);

// A row opens on its diff when it has one, and on the raw metadata otherwise.
$effect(() => {
  if (expanded) {
    metaView = hasChanges ? 'diff' : 'json';
  }
});

function copyMeta(click: MouseEvent): void {
  click.stopPropagation();
  void copyToClipboard(metaJson, 'Metadata copied');
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400"><span class="text-zinc-600">{occ.short} · </span>{occ.time}</span>
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			<!-- A dot in the actor's colour and not an initials block, which would be
			     the tallest thing in the row and set its height. -->
			<span
				class="size-[7px] flex-none rounded-full"
				style:background={e.actor_type === 'user' ? e.actorTone : e.actor_type === 'api_key' ? '#10b981' : '#71717a'}
			></span>
			<span class="overflow-hidden text-[12.5px] font-medium text-ellipsis whitespace-nowrap text-zinc-200">
				{e.actorLabel}
			</span>
		</span>

		<!-- Beside the actor's name and not under it, which would make every row two lines. -->
		<span class="text-[12.5px] whitespace-nowrap text-zinc-500">{actorTypeLabel}</span>

		<span class="inline-flex min-w-0 items-center gap-2">
			<code class="font-mono text-xs whitespace-nowrap text-zinc-300">{e.event}</code>
			{#if e.targetLabel}
				<code
					class="min-w-0 overflow-hidden rounded-[5px] border border-line-strong bg-surface-5 px-1.5 py-px font-mono text-[11.5px] text-ellipsis whitespace-nowrap text-zinc-400"
				>
					{e.targetLabel}
				</code>
			{/if}
		</span>
		<span class="inline-flex items-center gap-[7px] text-[12.5px] text-zinc-300">
			<span class="size-[7px] flex-none rounded-full" style:background={catColor}></span>{catLabel}
		</span>
		<span class="overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-zinc-400">{e.ip ?? '—'}</span>
		<span class="inline-flex items-center gap-1.5 text-xs font-medium" style:color={statusColor}>
			<span class="size-1.5 flex-none rounded-full" style:background={statusColor}></span>{statusLabel}
		</span>
	{/snippet}

	{#snippet details()}
		<DetailGrid items={detailItems} />

		<Panel>
			{#snippet header()}
				<FilterTabs tabs={VIEWS} bind:value={metaView} />
			{/snippet}
			{#snippet actions()}
				<ToolbarButton onclick={copyMeta}>Copy JSON</ToolbarButton>
			{/snippet}
			{#snippet children()}
				{#if metaView === 'diff'}
					{#if hasChanges}
						<div class="flex flex-col">
							<div
								class="grid grid-cols-[150px_1fr_22px_1fr] gap-3 border-b border-hairline px-3.5 py-[7px] text-[10px] font-medium tracking-[.05em] text-zinc-600 uppercase"
							>
								<span>Field</span><span>Before</span><span></span><span>After</span>
							</div>
							{#each changes as c (c.field)}
								<div
									class="grid grid-cols-[150px_1fr_22px_1fr] items-center gap-3 border-b border-hairline px-3.5 py-2.5 last:border-b-0"
								>
									<span class="text-xs text-zinc-400">{c.field}</span>
									<span
										class="max-w-full justify-self-start overflow-hidden rounded-[5px] border border-red-400/16 bg-red-400/7 px-2 py-0.5 font-mono text-[12.5px] text-ellipsis whitespace-nowrap text-[#f8a0a0]"
									>
										{c.from}
									</span>
									<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8h9M9 5l3 3-3 3" stroke="#52525b" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
									<span
										class="max-w-full justify-self-start overflow-hidden rounded-[5px] border border-emerald-500/18 bg-emerald-500/7 px-2 py-0.5 font-mono text-[12.5px] font-medium text-ellipsis whitespace-nowrap text-emerald-400"
									>
										{c.to}
									</span>
								</div>
							{/each}
						</div>
					{:else}
						<div class="flex items-center gap-[9px] px-3.5 py-4 text-[12.5px] text-zinc-600">
							<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" /><path d="M8 5.2v3.4M8 10.8v.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
							No field-level changes for this event — see the Metadata tab for event context.
						</div>
					{/if}
				{:else}
					<pre class="m-0 max-h-72 overflow-auto px-[13px] py-3 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-zinc-400">{metaJson}</pre>
				{/if}
			{/snippet}
		</Panel>
	{/snippet}
</ExpandableRow>
