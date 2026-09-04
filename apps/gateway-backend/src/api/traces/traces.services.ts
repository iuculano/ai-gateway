import { createHash } from 'node:crypto';
import { and, asc, db, eq, inArray, sql } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getCaller } from '@repo/hono';
import { err, ok, type Result } from 'neverthrow';
import { environment } from '../../environment';
import Schemas, {
  type CreateTraceRequest,
  type CreateTraceResponse,
  type GetTraceResponse,
  type ListTracesQuery,
  type ListTracesResponse,
  type TraceNodeShape,
} from './traces.schemas';

type TraceNotFoundFailure = {
  code: 'TRACE_NOT_FOUND';
  traceId: string;
};

export type GetTraceFailure = TraceNotFoundFailure;

/**
 * Try to derive a VictoriaMetrics tenant from the caller's organization id.
 *
 * This is slightly questionable from a uniqueness perspective, but saves
 * needing to keep an autoincrement or something on the organization table.

  * This should be collision free unless you have multiple orgs created in the
  * same millisecond, and even then it's unlikely.
  *
  * TODO THINK ABOUT IT MORE.
  */
function victoriaTenantHeaders(): Record<'AccountID' | 'ProjectID', string> {
  const orgId = getCaller().organization.id;
  const digest = createHash('sha256').update(orgId).digest();

  return {
    AccountID: digest.readUInt32BE(0).toString(),
    ProjectID: digest.readUInt32BE(4).toString(),
  };
}

/**
 * Runs a LogsQL query against VictoriaTraces for the caller's tenant.
 *
 * @param query
 * The LogsQL query to run.
 *
 * @returns
 * An array of rows returned by VictoriaTraces.
 */
async function victoriaQuery<T>(query: string): Promise<T[]> {
  const url = new URL('/select/logsql/query', environment.VICTORIA_TRACES_URL);
  url.searchParams.set('query', query);

  const response = await fetch(url, {
    headers: victoriaTenantHeaders(),
  });

  if (!response.ok) {
    throw new Error(`VictoriaTraces query failed with HTTP ${response.status}`);
  }

  // It returns newline-delimited JSON for some reason beyond earthly logic so
  // we need to parse it into an array.
  return convertJsonLinesToArray<T>(await response.text());
}

/** Aggregated VictoriaTraces row returned when listing traces. */
type VictoriaSummary = {
  trace_id: string;
  started_at: string;
  ended_at: string;
  span_count: string;
  tool_count: string;
  error_count: string;
  root_count: string;
  open_count: string;
  name?: string;
  root_status?: string;
  service_name?: string;
  environment?: string;
};

/** Raw VictoriaTraces span row used to build a trace's summary and waterfall. */
type VictoriaSpan = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano?: string;
  status_code?: string;
  scope_name?: string;
  scope_version?: string;
  'resource_attr:service.name'?: string;
  'resource_attr:deployment.environment.name'?: string;
  'span_attr:gen_ai.operation.name'?: string;
};

/** Usage and failure totals from gateway logs correlated with a trace. */
type GatewayTotals = {
  log_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  failed_log_count: number;
};

/** Fallback totals for traces that have no correlated gateway logs. */
const EMPTY_TOTALS: GatewayTotals = {
  log_count: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cost: 0,
  failed_log_count: 0,
};

/**
 * Dumb helper to parse newline-delimited JSON into an array of objects.
 *
 * @param body
 * The body of a VictoriaTraces response - newline-delimited JSON.
 *
 * @returns
 * An array of parsed objects.
 */
function convertJsonLinesToArray<T>(body: string): T[] {
  // Every response ends in a newline, and an empty result set is an empty
  // body - both split into a trailing '' that JSON.parse will not accept.
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Convert a span time value to nanoseconds.
 *
 * @param value
 * Span value, as a string, representing time.
 *
 * @returns
 * The time in nanoseconds as a bigint.
 */
function nanoseconds(value?: string): bigint {
  return BigInt(value ?? '0');
}

/**
 * Convert a span time value in nanoseconds to a JavaScript Date object.
 *
 * @param value
 * Span value, as a string, representing time in nanoseconds.
 *
 * @returns
 * A Date object representing the span start or end time.
 */
function dateFromNanoseconds(value: string): Date {
  return new Date(Number(nanoseconds(value) / 1_000_000n));
}

/** Derives the API trace status from VictoriaTraces summary fields. */
function statusFromSummary(row: VictoriaSummary): 'partial' | 'complete' | 'failed' {
  // No root span or at least one span has no end time.
  if (Number(row.root_count) === 0 || Number(row.open_count) > 0) {
    return 'partial';
  }

  // Status code - 0: unset, 1: ok, 2: error.
  return row.root_status === '2' ? 'failed' : 'complete';
}

/** Converts optional OpenTelemetry resource values into API trace tags. */
function traceTags(service?: string, deployment?: string): Record<string, string> {
  return {
    ...(service ? { service } : {}),
    ...(deployment ? { environment: deployment } : {}),
  };
}

type NormalizedTraceSummary = {
  traceId: string;
  name: string | null;
  status: 'partial' | 'complete' | 'failed';
  startedAt: Date;
  endedAt: Date | null;
  spanCount: number;
  toolCount: number;
  errorCount: number;
  tags: Record<string, string>;
};

function buildTraceSummary(summary: NormalizedTraceSummary, totals: GatewayTotals) {
  const { traceId, name, status, startedAt, endedAt, spanCount, toolCount, errorCount, tags } = summary;
  const { failed_log_count, ...trustedTotals } = totals;

  return {
    id: traceId,
    trace_id: traceId,
    name,
    status,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
    ...trustedTotals,
    span_count: spanCount,
    tool_count: toolCount,
    error_count: errorCount + failed_log_count,
    tags,
    created_at: startedAt,
    updated_at: endedAt ?? startedAt,
  };
}

function summaryFromRow(row: VictoriaSummary, totals: GatewayTotals) {
  const status = statusFromSummary(row);
  const startedAt = dateFromNanoseconds(row.started_at);

  return buildTraceSummary(
    {
      traceId: row.trace_id,
      name: row.name ?? null,
      status,
      startedAt,
      endedAt: status === 'partial' ? null : dateFromNanoseconds(row.ended_at),
      spanCount: Number(row.span_count),
      toolCount: Number(row.tool_count),
      errorCount: Number(row.error_count),
      tags: traceTags(row.service_name, row.environment),
    },
    totals,
  );
}

/**
 * Sum up the totals from a set of logs.
 *
 * @param rows
 * Array of log rows to sum up.
 *
 * @returns
 * The aggregated totals for the given log rows.
 */
function totalsFromLogs(rows: LogRow[]): GatewayTotals {
  const totals = rows.reduce<GatewayTotals>(
    (totals, row) => ({
      log_count: totals.log_count + 1,
      total_input_tokens: totals.total_input_tokens + (row.input_tokens ?? 0),
      total_output_tokens: totals.total_output_tokens + (row.output_tokens ?? 0),
      total_cost: totals.total_cost + Number(row.input_cost) + Number(row.output_cost),
      failed_log_count: totals.failed_log_count + (row.status === 'failed' ? 1 : 0),
    }),
    { ...EMPTY_TOTALS },
  );

  return totals;
}

/**
 * Returns map of totals, for a set of traces, keyed by trace id.
 *
 * @param traceIds
 * Array of trace ids to get totals for.
 */
async function totalsByTrace(traceIds: string[]): Promise<Map<string, GatewayTotals>> {
  const caller = getCaller();

  const totals = new Map<string, GatewayTotals>();

  // Bail early if there's no work to do.
  if (traceIds.length === 0) {
    return totals;
  }

  // Grab a list of rows with totals for each trace id.
  // biome-ignore format: the tenant conditions are easier to scan vertically
  const rows = await db
    .select({
      trace_id: logs.trace_id,
      log_count: sql<number>`count(*)::int`,
      input_tokens: sql<string>`coalesce(sum(${logs.input_tokens}), 0)::bigint`, // 0 instead of null if there's nothing
      output_tokens: sql<string>`coalesce(sum(${logs.output_tokens}), 0)::bigint`,
      cost: sql<string>`coalesce(sum(${logs.input_cost} + ${logs.output_cost}), 0)`,
      failed_log_count: sql<number>`count(*) filter (where ${logs.status} = 'failed')::int`, // number of failures
    })
    .from(logs)
    .where(and(
      eq(logs.organization_id, caller.organization.id),
      inArray(logs.trace_id, traceIds))
    )
    .groupBy(logs.trace_id);

  // Walk the array and turn it into a map keyed by trace id.
  for (const row of rows) {
    if (!row.trace_id) {
      // This is impossible given the query, but we need to narrow because the
      // column is nullable in the schema - logs might not have a trace.
      continue;
    }

    totals.set(row.trace_id, {
      log_count: Number(row.log_count),
      total_input_tokens: Number(row.input_tokens),
      total_output_tokens: Number(row.output_tokens),
      total_cost: Number(row.cost),
      failed_log_count: Number(row.failed_log_count),
    });
  }

  return totals;
}

// thank you codex for figuring this horrorshow shit out
function summaryQuery(query: ListTracesQuery, cursorStart?: bigint): string {
  const aggregates = [
    'min(start_time_unix_nano) started_at',
    'max(end_time_unix_nano) ended_at',
    'count_uniq(span_id) span_count',
    'count_uniq(span_id) if (name:="execute_tool "*) tool_count',
    'count_uniq(span_id) if (status_code:=2) error_count',
    'count_uniq(span_id) if (!parent_span_id:*) root_count',
    'count_uniq(span_id) if (end_time_unix_nano:=0) open_count',
    'any(name) if (!parent_span_id:*) name',
    'any(status_code) if (!parent_span_id:*) root_status',
    'any("resource_attr:service.name") if (!parent_span_id:*) service_name',
    'any("resource_attr:deployment.environment.name") if (!parent_span_id:*) environment',
  ].join(', ');

  const parts = ['trace_id:*', `| stats by (trace_id) ${aggregates}`];

  if (query.status === 'failed') {
    parts.push('| filter root_status:=2 and root_count:>0 and open_count:=0');
  }

  if (query.status === 'complete') {
    parts.push('| filter root_status:!=2 and root_count:>0 and open_count:=0');
  }
  if (query.status === 'partial') {
    parts.push('| filter root_count:=0 or open_count:>0');
  }

  if (cursorStart !== undefined) {
    parts.push(`| filter started_at:<${cursorStart}`);
  }

  parts.push(`| sort by (started_at desc) limit ${query.limit + 1}`);
  return parts.join(' ');
}

// This had me confused for a while - errors and retries can seemingly lead to
// duplicate spans in VictoriaTraces.
async function getSpansForTrace(traceId: string): Promise<VictoriaSpan[]> {
  const rows = await victoriaQuery<VictoriaSpan>(`trace_id:=${traceId}`);
  const spans = new Map<string, VictoriaSpan>();

  for (const row of rows) {
    const current = spans.get(row.span_id);
    if (!current || nanoseconds(row.end_time_unix_nano) >= nanoseconds(current.end_time_unix_nano)) {
      spans.set(row.span_id, row);
    }
  }

  return [...spans.values()];
}

/**
 * Simple helper to get the status enum on a span.
 *
 * @param span
 * The span to get the status for.
 */
function spanStatus(span: VictoriaSpan): TraceNodeShape['status'] {
  if (span.status_code === '1') return 'ok';
  if (span.status_code === '2') return 'error';
  return 'unset';
}

// basically gen_ai.operation.name
const SPAN_KINDS: Record<string, TraceNodeShape['kind']> = {
  chat: 'llm',
  generate_content: 'llm',
  text_completion: 'llm',
  embeddings: 'embedding',
  execute_tool: 'tool',
  create_agent: 'workflow',
  invoke_agent: 'workflow',
  rerank: 'rerank',
};

function spanKind(span: VictoriaSpan): TraceNodeShape['kind'] {
  const operation = span['span_attr:gen_ai.operation.name']?.toLowerCase();
  const operationKind = operation ? SPAN_KINDS[operation] : undefined;
  if (operationKind) {
    return operationKind;
  }

  const namePrefix = span.name.toLowerCase().split(' ')[0];
  const nameKind = namePrefix ? SPAN_KINDS[namePrefix] : undefined;
  if (nameKind) {
    return nameKind;
  }

  return span.parent_span_id ? 'custom' : 'workflow';
}

// Node that doesn't know its depth or start offset yet.
type UnresolvedNode = {
  id: string;
  parentId: string | null;
  startedAt: number;
  durationMs: number;
  fields: Omit<TraceNodeShape, 'id' | 'parent_id' | 'depth' | 'start_offset_ms' | 'duration_ms'>;
};

function createNodesFromSpans(spans: VictoriaSpan[]): UnresolvedNode[] {
  return spans.map((span) => {
    const start = nanoseconds(span.start_time_unix_nano);
    const end = nanoseconds(span.end_time_unix_nano);
    const scope = span.scope_name || '';

    return {
      id: span.span_id,
      parentId: span.parent_span_id || null,
      startedAt: Number(start / 1_000_000n),
      durationMs: end > start ? Number((end - start) / 1_000_000n) : 0,
      fields: {
        source: 'application_span',
        kind: spanKind(span),
        name: span.name,
        status: spanStatus(span),
        model: null,
        provider: null,
        input_tokens: null,
        output_tokens: null,
        cost: null,
        log_id: null,
        attributes: {
          ...(span['resource_attr:service.name'] ? { service: span['resource_attr:service.name'] } : {}),
          ...(scope ? { scope } : {}),
        },
      },
    };
  });
}

const LOG_STATUSES = {
  incomplete: 'unset',
  complete: 'ok',
  failed: 'error',
} as const;

function logNodes(rows: LogRow[], takenIds: Set<string>): UnresolvedNode[] {
  return rows.map((row) => {
    const id = row.span_id && !takenIds.has(row.span_id) ? row.span_id : `log:${row.id}`;
    takenIds.add(id);

    return {
      id,
      parentId: row.parent_span_id || null,
      startedAt: row.created_at.getTime(),
      durationMs: row.response_time_ms ?? 0,
      fields: {
        source: 'gateway_log',
        kind: 'llm',
        name: `gateway · ${row.model}`,
        status: LOG_STATUSES[row.status],
        model: row.model,
        provider: row.provider,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost: Number(row.input_cost) + Number(row.output_cost),
        log_id: row.id,
        attributes: row.tags ?? {},
      },
    };
  });
}

/**
 * Resolves parent relationships and waterfall positions for trace nodes.
 *
 * @param unresolvedNodes
 * Nodes that have absolute start times but no calculated depth or offset yet.
 *
 * @param traceStartMs
 * The trace's earliest start time, used as the waterfall's zero point.
 */
function resolveNodes(unresolvedNodes: UnresolvedNode[], traceStartMs: number): TraceNodeShape[] {
  // Index every node so parent ids can be validated without repeatedly
  // scanning the full list.
  const nodesById = new Map(unresolvedNodes.map((node) => [node.id, node]));
  const childrenByParentId = new Map<string, UnresolvedNode[]>();
  const rootNodes: UnresolvedNode[] = [];

  // Separate root nodes from child nodes and group each child under its parent.
  // Missing and self-referencing parents cannot form a valid tree, so treat
  // those nodes as roots instead.
  for (const node of unresolvedNodes) {
    let validParentId: string | null = null;

    if (node.parentId) {
      const referencesItself = node.parentId === node.id;
      const parentExists = nodesById.has(node.parentId);

      if (!referencesItself && parentExists) {
        validParentId = node.parentId;
      }
    }

    if (validParentId === null) {
      node.parentId = null;
      rootNodes.push(node);
      continue;
    }

    const childNodes = childrenByParentId.get(validParentId) ?? [];
    childNodes.push(node);
    childrenByParentId.set(validParentId, childNodes);
  }

  // Keep roots and siblings in order. Use the id as a stable tie-breaker when
  // two nodes have the same start time.
  function compareByStart(left: UnresolvedNode, right: UnresolvedNode): number {
    const startDifference = left.startedAt - right.startedAt;
    if (startDifference !== 0) {
      return startDifference;
    }

    return left.id.localeCompare(right.id);
  }

  rootNodes.sort(compareByStart);
  for (const childNodes of childrenByParentId.values()) {
    childNodes.sort(compareByStart);
  }

  const resolvedNodes: TraceNodeShape[] = [];
  const visitedNodeIds = new Set<string>();

  // Walk one tree depth-first, calculating each node's depth and position in
  // the waterfall.
  function appendTree(rootNode: UnresolvedNode): void {
    const traversalStack: Array<{ node: UnresolvedNode; depth: number }> = [{ node: rootNode, depth: 0 }];

    while (traversalStack.length > 0) {
      const entry = traversalStack.pop();
      if (!entry) {
        continue;
      }

      const currentNode = entry.node;

      // Skip nodes already emitted. This also prevents parent cycles from
      // making the traversal loop forever.
      if (visitedNodeIds.has(currentNode.id)) {
        continue;
      }

      visitedNodeIds.add(currentNode.id);

      const resolvedNode: TraceNodeShape = {
        ...currentNode.fields,
        id: currentNode.id,
        parent_id: currentNode.parentId,
        depth: entry.depth,
        start_offset_ms: Math.max(0, currentNode.startedAt - traceStartMs),
        duration_ms: Math.max(0, currentNode.durationMs),
      };
      resolvedNodes.push(resolvedNode);

      const childNodes = childrenByParentId.get(currentNode.id) ?? [];

      // The stack is last-in, first-out. Push children in reverse so they are
      // visited in the chronological order established above.
      for (let index = childNodes.length - 1; index >= 0; index -= 1) {
        const childNode = childNodes[index];
        if (!childNode) {
          continue;
        }

        traversalStack.push({ node: childNode, depth: entry.depth + 1 });
      }
    }
  }

  // Resolve every tree that has a natural root first.
  for (const rootNode of rootNodes) {
    appendTree(rootNode);
  }

  // A malformed trace can contain a cycle with no natural root. Promote the
  // first unvisited node in each remaining component so no data is omitted.
  const remainingNodes = unresolvedNodes.toSorted(compareByStart);
  for (const node of remainingNodes) {
    if (visitedNodeIds.has(node.id)) {
      continue;
    }

    node.parentId = null;
    appendTree(node);
  }

  return resolvedNodes;
}

function summaryFromSpans(traceId: string, spans: VictoriaSpan[], totals: GatewayTotals) {
  // Sort the spans and pick the root as the source of trace-level metadata.
  // Fall back to the first span when a partial trace has no root yet.
  const ordered = spans.toSorted((left, right) => left.start_time_unix_nano.localeCompare(right.start_time_unix_nano));
  const roots = ordered.filter((span) => !span.parent_span_id);
  const root = roots[0] ?? ordered[0];

  // Find the trace's overall time boundaries across all of its spans.
  const started = ordered.reduce(
    (earliest, span) =>
      nanoseconds(span.start_time_unix_nano) < earliest ? nanoseconds(span.start_time_unix_nano) : earliest,
    nanoseconds(ordered[0]?.start_time_unix_nano),
  );
  const ended = ordered.reduce(
    (latest, span) => (nanoseconds(span.end_time_unix_nano) > latest ? nanoseconds(span.end_time_unix_nano) : latest),
    0n,
  );

  // Derive the trace status from its root and whether every span has ended.
  const partial = roots.length === 0 || ordered.some((span) => nanoseconds(span.end_time_unix_nano) === 0n);
  const failed = roots.some((span) => spanStatus(span) === 'error');

  // Convert the nanosecond boundaries into values used by the API response.
  const startedAt = dateFromNanoseconds(started.toString());
  const endedAt = partial ? null : dateFromNanoseconds(ended.toString());

  // Combine the span-derived summary with usage totals from gateway logs.
  return buildTraceSummary(
    {
      traceId,
      name: root?.name ?? null,
      status: partial ? 'partial' : failed ? 'failed' : 'complete',
      startedAt,
      endedAt,
      spanCount: ordered.length,
      toolCount: ordered.filter((span) => spanKind(span) === 'tool').length,
      errorCount: ordered.filter((span) => spanStatus(span) === 'error').length,
      tags: traceTags(root?.['resource_attr:service.name'], root?.['resource_attr:deployment.environment.name']),
    },
    totals,
  );
}

/**
 * Creates a trace from an OTLP/HTTP JSON trace export.
 *
 * @param request
 * OTLP trace body.
 */
async function createTrace(request: CreateTraceRequest): Promise<CreateTraceResponse> {
  // Try to figure out if there's anything to even do.
  //
  // Can't just check resourceSpans.length because it's possible to get back
  // non-empty arrays with no spans in them.
  const hasSpans = request.resourceSpans.some((resource) =>
    resource.scopeSpans.some((scope) => scope.spans.length > 0),
  );

  if (!hasSpans) {
    return {};
  }

  // Try to push the trace to VictoriaMetrics.
  const response = await fetch(new URL('/insert/opentelemetry/v1/traces', environment.VICTORIA_TRACES_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...victoriaTenantHeaders(),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`VictoriaTraces push failed with HTTP ${response.status}`);
  }

  // Partial success may return a body. A "full" sucess will return a 204 with
  // no body.
  const body = await response.text();
  if (body) {
    const json = JSON.parse(body);
    return Schemas.createTrace.response.parse(json);
  }

  return {};
}

async function listTraces(query: ListTracesQuery): Promise<ListTracesResponse> {
  const cursorId = query.after_id;
  const cursorSpans = cursorId ? await getSpansForTrace(cursorId) : [];

  // Just bail early if there's no spans for a given trace.
  if (cursorId && cursorSpans.length === 0) {
    return Schemas.listTraces.response.parse({
      data: [],
      meta: { oldest_id: null, more_data: false },
    });
  }

  // Try to find the earliest start time of the spans for the cursor trace.
  const cursorStart = cursorSpans.reduce<bigint | undefined>((earliest, span) => {
    const start = nanoseconds(span.start_time_unix_nano);
    return earliest === undefined || start < earliest ? start : earliest;
  }, undefined);

  // If cursorStartr is undefined, it just grabs the latest page of traces.
  const rows = await victoriaQuery<VictoriaSummary>(summaryQuery(query, cursorStart));
  const moreData = rows.length > query.limit;
  const page = rows.slice(0, query.limit); // trim the probe row if we got one

  // A page never contains gateway log rows. It contains one aggregated
  // VictoriaSummary per trace only. summaryFromRow() (which might be named a
  // little poorly) will combine the VictoriaSummary with any correlated gateway
  // logs to produce a complete trace summary.
  const totals = await totalsByTrace(page.map((row) => row.trace_id));
  const data = page.map((row) => summaryFromRow(row, totals.get(row.trace_id) ?? EMPTY_TOTALS));

  return Schemas.listTraces.response.parse({
    data,
    meta: {
      oldest_id: data.at(-1)?.trace_id ?? null, // data is ordered newest first
      more_data: moreData,
    },
  });
}

/**
 *  Retrieve a trace's summary and its waterfall.
 *
 * @param traceId
 * The ID of a trace.
 *
 * @returns
 * The summary of the trace and its waterfall, or a failure if the trace was not
 * found.
 */
async function getTrace(traceId: string): Promise<Result<GetTraceResponse, GetTraceFailure>> {
  const caller = getCaller();

  // See if we have any spans to begin with.
  const spans = await getSpansForTrace(traceId);
  if (spans.length === 0) {
    return err({ code: 'TRACE_NOT_FOUND', traceId });
  }

  // Load any logs that are correlated with this trace.
  // biome-ignore format: looks nicer
  const correlatedLogs = await db
    .select()
    .from(logs)
    .where(and(
      eq(logs.organization_id, caller.organization.id),
      eq(logs.trace_id, traceId))
    )
    .orderBy(asc(logs.created_at), asc(logs.id));

  // Usage for this trace.
  const totals = totalsFromLogs(correlatedLogs);

  // Complete trace summary.
  const summary = summaryFromSpans(traceId, spans, totals);

  // Start creating the nodes for the waterfall.
  //
  // Note that at this point, the nodes don't know where they are in the
  // waterfall - they don't have depth or start offsets yet.
  const applicationNodes = createNodesFromSpans(spans);
  const unresolved = [
    ...applicationNodes, // customer submitted spans
    ...logNodes(correlatedLogs, new Set(applicationNodes.map((node) => node.id))), // sourced from gateway logs
  ];

  // Find the earliest start time so we can normalize the waterfall to start at
  // 0 and all the other nodes are offset relative from that.
  const startedAtArray = unresolved.map((node) => node.startedAt);
  const startMs = Math.min(...startedAtArray);

  const nodes = resolveNodes(unresolved, startMs);

  // Walk the nodes to find the end of the waterfall, so we can report the total
  // window.
  let windowMs = 0;
  for (const node of nodes) {
    const endMs = node.start_offset_ms + node.duration_ms;
    windowMs = Math.max(windowMs, endMs);
  }

  return ok(
    Schemas.getTrace.response.parse({
      trace: {
        ...summary,
        detail_status:
          summary.status === 'partial' || correlatedLogs.some((row) => row.status === 'incomplete')
            ? 'partial'
            : 'complete',
        window_ms: windowMs,
      },
      nodes,
    }),
  );
}

export default {
  createTrace,
  listTraces,
  getTrace,
};
