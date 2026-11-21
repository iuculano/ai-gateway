import { expect, test } from 'bun:test';
import type { Trace, TraceNode } from '../../src/lib/api/types';
import { filterTraces, nodeColor, nodeSpan, tagPairs, traceLegend } from '../../src/lib/data/traces';

const ERROR_RED = '#ef4444';

function trace(fields: Partial<Trace>): Trace {
  return {
    trace_id: 'trace',
    name: null,
    status: 'ok',
    error_count: 0,
    duration_ms: 100,
    tags: null,
    ...fields,
  } as Trace;
}

function node(fields: Partial<TraceNode>): TraceNode {
  return {
    source: 'application_span',
    kind: 'custom',
    status: 'unset',
    start_offset_ms: 0,
    duration_ms: 0,
    ...fields,
  } as TraceNode;
}

// filterTraces

test('the Errors tab keeps runs with a failure, and the Slow tab runs of eight seconds or more', () => {
  const traces = [
    trace({ trace_id: 'clean' }),
    trace({ trace_id: 'broken', error_count: 2 }),
    trace({ trace_id: 'slow', duration_ms: 8_000 }),
    trace({ trace_id: 'open', duration_ms: null }),
  ];

  expect(filterTraces(traces, 'all', '')).toHaveLength(4);
  expect(filterTraces(traces, 'errors', '').map((run) => run.trace_id)).toEqual(['broken']);
  expect(filterTraces(traces, 'slow', '').map((run) => run.trace_id)).toEqual(['slow']);
});

test('search matches a run by name, id, status or tag, whatever the case', () => {
  const traces = [
    trace({ trace_id: 'aaa111', name: 'Checkout agent' }),
    trace({ trace_id: 'bbb222', tags: { env: 'prod' } }),
  ];

  expect(filterTraces(traces, 'all', ' checkout ').map((run) => run.trace_id)).toEqual(['aaa111']);
  expect(filterTraces(traces, 'all', 'BBB').map((run) => run.trace_id)).toEqual(['bbb222']);
  expect(filterTraces(traces, 'all', 'env=prod').map((run) => run.trace_id)).toEqual(['bbb222']);
  expect(filterTraces(traces, 'all', 'ok')).toHaveLength(2);
});

test('tag values that are not strings are still shown', () => {
  expect(tagPairs({ attempt: 3, cached: false })).toEqual([
    ['attempt', '3'],
    ['cached', 'false'],
  ]);
  expect(tagPairs(null)).toEqual([]);
});

// Legend

test('the legend counts a node the way it is drawn, most common first', () => {
  const nodes = [
    node({ kind: 'llm' }),
    node({ kind: 'llm' }),
    node({ kind: 'tool' }),
    node({ kind: 'llm', status: 'error' }),
    node({ source: 'gateway_log', kind: 'llm' }),
  ];

  const legend = traceLegend(nodes);

  // The failed model call is an Error, and the gateway's own record is a
  // Gateway log whatever kind it carries.
  expect(legend.map((entry) => [entry.label, entry.count])).toEqual([
    ['Model call', 2],
    ['Tool', 1],
    ['Error', 1],
    ['Gateway log', 1],
    ['Provider attempt', 0],
  ]);
  expect(nodeColor(nodes[3] as TraceNode)).toBe(ERROR_RED);
});

test('a span that never set a status is not drawn as a failure', () => {
  expect(nodeColor(node({ kind: 'llm', status: 'unset' }))).not.toBe(ERROR_RED);
});

// nodeSpan

test('a bar is placed by when its node started and how long it ran', () => {
  const span = nodeSpan(node({ start_offset_ms: 250, duration_ms: 500 }), 1_000, 100, 1.2);

  expect(span).toEqual({ left: 25, width: 50 });
});

test('a bar is never too thin to see, and never runs past the end of the run', () => {
  const instant = nodeSpan(node({ start_offset_ms: 500, duration_ms: 0 }), 60_000, 100, 1.2);
  const overrun = nodeSpan(node({ start_offset_ms: 900, duration_ms: 500 }), 1_000, 100, 1.2);

  expect(instant.width).toBe(1.2);
  expect(overrun).toEqual({ left: 90, width: 10 });
});

test('a run that is still open has no length to place a bar against', () => {
  const span = nodeSpan(node({ start_offset_ms: 250, duration_ms: 500 }), 0, 100, 1.2);

  expect(span).toEqual({ left: 0, width: 1.2 });
});
