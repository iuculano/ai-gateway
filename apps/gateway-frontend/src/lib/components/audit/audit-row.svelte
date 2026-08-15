<script lang="ts">
import { toast } from 'svelte-sonner';
import type { DetailItem } from '$lib/components/app/detail-grid.svelte';
import DetailGrid from '$lib/components/app/detail-grid.svelte';
import ExpandableRow from '$lib/components/app/expandable-row.svelte';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import Panel from '$lib/components/app/panel.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import { fmtChangeValue, fmtTs, humanize, parseUA } from '$lib/data/format';
import type { AuditEvent } from '$lib/data/types';

let {
  event,
  cols,
  catColor,
  catLabel,
  expanded,
  ontoggle,
}: {
  event: AuditEvent;
  cols: string;
  catColor: string;
  catLabel: string;
  expanded: boolean;
  ontoggle: () => void;
} = $props();

const e = $derived(event);
const occ = $derived(fmtTs(e.occurredAt));
const rec = $derived(fmtTs(e.createdAt));
const statusColor = $derived(e.status === 'success' ? '#10b981' : '#f87171');
const statusLabel = $derived(e.status === 'success' ? 'Success' : 'Failure');
const actorTypeLabel = $derived({ user: 'User', api_key: 'API key', system: 'System' }[e.actorType] ?? e.actorType);
const changes = $derived(
  e.metadata?.changes
    ? Object.entries(e.metadata.changes).map(([field, v]) => ({
        field: humanize(field),
        from: fmtChangeValue(v.old) ?? '∅',
        to: fmtChangeValue(v.new) ?? '∅',
      }))
    : [],
);
const hasChanges = $derived(changes.length > 0);
const metaJson = $derived(JSON.stringify(e.metadata, null, 2));

const detailItems: DetailItem[] = $derived([
  { label: 'Event ID', value: e.id },
  { label: 'Action', value: e.action },
  { label: 'Status', value: statusLabel, tone: statusColor, mono: false },
  { label: 'Request ID', value: e.requestId },
  { label: `Actor · ${actorTypeLabel}`, value: e.actorName, mono: false },
  { label: 'Actor ID', value: e.actorId ?? '—' },
  { label: 'Target type', value: e.targetType ?? '—' },
  { label: 'Target ID', value: e.targetId ?? '—' },
  { label: 'Occurred at', value: occ.full },
  { label: 'Recorded at', value: rec.full },
  { label: 'IP address', value: e.ip ?? '—' },
  { label: 'User agent', value: parseUA(e.userAgent), mono: false, title: e.userAgent ?? undefined },
]);

const VIEWS = [
  { id: 'diff' as const, label: 'Diff' },
  { id: 'json' as const, label: 'Metadata' },
];

let metaView: 'diff' | 'json' = $state('diff');
$effect(() => {
  if (expanded) metaView = hasChanges ? 'diff' : 'json';
});

function copyMeta(ev: MouseEvent) {
  ev.stopPropagation();
  navigator.clipboard?.writeText(metaJson).catch(() => {});
  toast.success('Metadata copied');
}
</script>

<ExpandableRow {cols} {expanded} {ontoggle}>
	{#snippet cells()}
		<span class="font-mono text-xs text-zinc-400"><span class="text-zinc-600">{occ.short} · </span>{occ.time}</span>
		<span class="inline-flex min-w-0 items-center gap-[9px]">
			{#if e.actorType === 'user'}
				<span
					class="flex size-6 flex-none items-center justify-center rounded-full text-[10.5px] font-semibold"
					style:background={e.actorTone + '26'}
					style:color={e.actorTone}
				>
					{e.initials}
				</span>
			{:else if e.actorType === 'api_key'}
				<span class="flex size-6 flex-none items-center justify-center rounded-[7px] bg-emerald-500/14 text-emerald-500">
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="8" r="2.6" stroke="currentColor" stroke-width="1.4" /><path d="M7.6 8H14M11.4 8v2.2M13.2 8v1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
				</span>
			{:else}
				<span class="flex size-6 flex-none items-center justify-center rounded-[7px] bg-track text-zinc-500">
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
				</span>
			{/if}
			<span class="flex min-w-0 flex-col leading-[1.25]">
				<span class="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap text-zinc-200">
					{e.actorName}
				</span>
				<span class="text-[10.5px] text-zinc-600">{actorTypeLabel}</span>
			</span>
		</span>
		<span class="inline-flex min-w-0 items-center gap-2">
			<code class="font-mono text-xs whitespace-nowrap text-zinc-300">{e.action}</code>
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
