import type { Trace, TraceNode } from '#lib/api/types.ts';

export type TraceFilter = 'all' | 'errors' | 'slow';

// Above this, a run is worth surfacing on its own tab.
const SLOW_THRESHOLD_MS = 8_000;

const CUSTOM = { label: 'Other', color: '#8a8f98' };

// What a node is drawn and counted as, for the waterfall, the map and the
// legend alike.
//
// Application spans are told apart by kind. Colouring by source made a large
// agent run almost entirely one colour, which is the same as no colour. The two
// gateway-owned sources keep their own entry whatever the kind, because a
// gateway log is a record Relay stands behind and should not change appearance
// with what the customer's span happened to be called.
//
// Custom is the quiet one. Steps and outbound fetches are the glue, and letting
// them recede is what makes the model and tool calls legible.
const NODE_KINDS: Record<string, { label: string; color: string }> = {
  error: { label: 'Error', color: '#ef4444' },
  workflow: { label: 'Workflow', color: '#a78bfa' },
  llm: { label: 'Model call', color: '#60a5fa' },
  tool: { label: 'Tool', color: '#fbbf24' },
  retrieval: { label: 'Retrieval', color: '#f472b6' },
  embedding: { label: 'Embedding', color: '#22d3ee' },
  rerank: { label: 'Rerank', color: '#c084fc' },
  custom: CUSTOM,
  gateway_log: { label: 'Gateway log', color: '#10b981' },
  provider_attempt: { label: 'Provider attempt', color: '#38bdf8' },
};

/**
 * A jsonb map as pairs of strings. It arrives as an open object and not as a
 * typed map.
 */
export function tagPairs(tags: unknown): [string, string][] {
  return Object.entries((tags ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)]);
}

function matchesTrace(trace: Trace, filter: TraceFilter, query: string): boolean {
  if (filter === 'errors' && trace.error_count === 0) {
    return false;
  }

  if (filter === 'slow' && (trace.duration_ms ?? 0) < SLOW_THRESHOLD_MS) {
    return false;
  }

  if (!query) {
    return true;
  }

  const tags = tagPairs(trace.tags).map(([key, value]) => `${key}=${value}`);
  const searchable = [trace.name ?? '', trace.trace_id, trace.status, ...tags].join(' ');

  return searchable.toLowerCase().includes(query);
}

/**
 * The runs a tab shows, narrowed to those matching the search box by name, id,
 * status or tag.
 */
export function filterTraces(traces: Trace[], filter: TraceFilter, search: string): Trace[] {
  const query = search.trim().toLowerCase();

  return traces.filter((trace) => matchesTrace(trace, filter, query));
}

/**
 * Which legend entry a node belongs to. Colour and legend both come from this,
 * so an errored span is counted under Error because that is how it is drawn.
 */
function nodeKind(node: TraceNode): string {
  // Only an error is drawn differently. OpenTelemetry leaves almost every span
  // unset and discourages setting OK, so treating unset as a warning painted
  // healthy runs as though half of them had gone wrong.
  if (node.status === 'error') {
    return 'error';
  }

  return node.source === 'application_span' ? node.kind : node.source;
}

/**
 * The colour a node's bar is drawn in.
 */
export function nodeColor(node: TraceNode): string {
  return (NODE_KINDS[nodeKind(node)] ?? CUSTOM).color;
}

/**
 * The legend for one run, built from what it contains, most common first.
 */
export function traceLegend(nodes: TraceNode[]): { key: string; label: string; color: string; count: number }[] {
  // Provider attempts are listed even at zero. The node contract has them and
  // Relay does not emit them yet, and an entry reading 0 says that better than
  // a missing row would.
  const counts = new Map<string, number>([['provider_attempt', 0]]);

  for (const node of nodes) {
    const key = nodeKind(node);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const legend = [...counts].map(([key, count]) => ({
    key: key,
    label: NODE_KINDS[key]?.label ?? key,
    color: (NODE_KINDS[key] ?? CUSTOM).color,
    count: count,
  }));

  return legend.sort((a, b) => b.count - a.count);
}

/**
 * Where a node's bar sits along its run, as a start and a length.
 *
 * @param node
 * The node to place.
 *
 * @param windowMs
 * How long the run lasted, or zero while it is open and nothing has reported
 * an end.
 *
 * @param scale
 * The full width in the caller's units, such as 100 for a percentage.
 *
 * @param minimum
 * The narrowest a bar may be. A span of a few milliseconds in a run of minutes
 * would otherwise round to nothing, and no work should be invisible.
 */
export function nodeSpan(
  node: TraceNode,
  windowMs: number,
  scale: number,
  minimum: number,
): { left: number; width: number } {
  if (windowMs === 0) {
    return { left: 0, width: minimum };
  }

  const left = Math.min(scale, (node.start_offset_ms / windowMs) * scale);
  const width = Math.min(scale - left, (node.duration_ms / windowMs) * scale);

  return { left: left, width: Math.max(minimum, width) };
}
