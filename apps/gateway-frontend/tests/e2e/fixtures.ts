import type { SeriesResponse } from '../../src/lib/api/analytics';
import type {
  ApiKey,
  CatalogProvider,
  CreatedApiKey,
  Log,
  Prompt,
  PromptVersion,
  Trace,
  TraceDetail,
} from '../../src/lib/api/types';
import type { ApiMock, RecordedApiRequest } from './api-mock';

export const IDS = {
  apiKey: '0198f100-0000-7000-8000-000000000001',
  prompt: '0198f100-0000-7000-8000-000000000002',
  promptVersion: '0198f100-0000-7000-8000-000000000003',
  successLog: '0198f100-0000-7000-8000-000000000004',
  failedLog: '0198f100-0000-7000-8000-000000000005',
  actor: '0198f100-0000-7000-8000-000000000006',
  model: '0198f100-0000-7000-8000-000000000007',
  trace: '0198f100-0000-7000-8000-000000000008',
  failedTrace: '0198f100-0000-7000-8000-000000000009',
} as const;

/** W3C ids, which are hex rather than uuids - see the trace schemas. */
export const TRACE_IDS = {
  workflow: 'f3a8c17d4e2b49b6a5018c9209f4d811',
  failed: '4bf92f3577b34da6a3ce929d0e0e4736',
  rootSpan: '8f2b7c1d9a4e6102',
  llmSpan: '1c7e93a842d6b501',
  gatewaySpan: '36b8a2e419f70c55',
} as const;

export const PAGE_META = { oldest_id: null, more_data: false } as const;
export const LOG_META = { oldest_id: null, newest_id: null, more_data: false } as const;

const CREATED_AT = '2026-08-20T14:00:00.000Z';
const UPDATED_AT = '2026-08-20T14:05:00.000Z';

export const API_KEY: ApiKey = {
  id: IDS.apiKey,
  name: 'CI deployer',
  description: 'Created by the browser test',
  creator_id: IDS.actor,
  scopes: 'api-keys:read',
  rate_limit_requests: null,
  rate_limit_window: null,
  allowed_ips: null,
  expires_at: null,
  revoked_at: null,
  revoked_by: null,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  total_requests: 0,
};

export const CREATED_API_KEY: CreatedApiKey = {
  ...API_KEY,
  key: 'relay_test_secret_once_123456789',
};

export const PROMPT: Prompt = {
  id: IDS.prompt,
  name: 'support-triage',
  description: 'Triage incoming support requests',
  active_version: null,
  tags: {},
  creator_id: IDS.actor,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

export const PROMPT_VERSION: PromptVersion = {
  id: IDS.promptVersion,
  prompt_id: IDS.prompt,
  prompt: 'Help {{ customer_name }} with their support request.',
  version: 1,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

export const SUCCESS_LOG: Log = {
  id: IDS.successLog,
  model: 'gpt-5',
  provider: 'openai',

  // Correlated, so the logs table's trace column has something to render and
  // the link back to the run is covered.
  trace_id: TRACE_IDS.workflow,
  span_id: TRACE_IDS.gatewaySpan,
  parent_span_id: TRACE_IDS.llmSpan,
  status: 'complete',
  actor_type: 'user',
  actor_id: IDS.actor,
  input_tokens: 12,
  output_tokens: 8,
  input_cost: 0.00012,
  output_cost: 0.00024,
  response_time_ms: 420,
  tags: { env: 'test' },
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  has_request: true,
  has_response: true,
};

export const FAILED_LOG: Log = {
  ...SUCCESS_LOG,
  id: IDS.failedLog,
  model: 'gpt-5-mini',
  status: 'failed',
  input_tokens: 5,
  output_tokens: null,
  output_cost: 0,
  response_time_ms: 90,
  has_response: false,
};

export const TRACE: Trace = {
  id: IDS.trace,
  trace_id: TRACE_IDS.workflow,
  name: 'checkout-recovery-agent',
  status: 'complete',
  started_at: '2026-08-20T14:00:00.000Z',
  ended_at: '2026-08-20T14:00:12.180Z',
  duration_ms: 12_180,
  total_input_tokens: 1_480,
  total_output_tokens: 312,
  total_cost: 0.0028,
  log_count: 1,
  span_count: 2,
  tool_count: 0,
  error_count: 0,
  tags: { environment: 'production' },
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

export const FAILED_TRACE: Trace = {
  ...TRACE,
  id: IDS.failedTrace,
  trace_id: TRACE_IDS.failed,
  name: 'customer-support-escalation',
  status: 'failed',
  duration_ms: 2_400,
  error_count: 1,
};

/**
 * The waterfall as the backend projects it: application spans and the gateway
 * log correlated to them, already ordered, with their depth resolved.
 */
export const TRACE_DETAIL: TraceDetail = {
  trace: { ...TRACE, detail_status: 'complete', window_ms: 12_180 },
  nodes: [
    {
      id: TRACE_IDS.rootSpan,
      parent_id: null,
      depth: 0,
      source: 'application_span',
      kind: 'workflow',
      name: 'checkout-recovery-agent',
      status: 'ok',
      start_offset_ms: 0,
      duration_ms: 12_180,
      model: null,
      provider: null,
      input_tokens: null,
      output_tokens: null,
      cost: null,
      log_id: null,
      attributes: { service: 'invoice-worker' },
    },
    {
      id: TRACE_IDS.llmSpan,
      parent_id: TRACE_IDS.rootSpan,
      depth: 1,
      source: 'application_span',
      kind: 'llm',
      name: 'streamText · diagnose checkout',
      status: 'ok',
      start_offset_ms: 180,
      duration_ms: 2_240,
      model: null,
      provider: null,
      input_tokens: null,
      output_tokens: null,
      cost: null,
      log_id: null,
      attributes: {},
    },
    {
      id: TRACE_IDS.gatewaySpan,
      parent_id: TRACE_IDS.llmSpan,
      depth: 2,
      source: 'gateway_log',
      kind: 'llm',
      name: 'gateway · gpt-5-mini',
      status: 'ok',
      start_offset_ms: 236,
      duration_ms: 2_058,
      model: 'gpt-5-mini',
      provider: 'openai',
      input_tokens: 1_480,
      output_tokens: 312,
      cost: 0.0028,
      log_id: IDS.successLog,
      attributes: { environment: 'production' },
    },
  ],
};

export const FAILED_TRACE_DETAIL: TraceDetail = {
  trace: { ...FAILED_TRACE, detail_status: 'partial', window_ms: 2_400 },
  nodes: [
    {
      ...TRACE_DETAIL.nodes[0],
      name: 'customer-support-escalation',
      status: 'error',
      duration_ms: 2_400,
      attributes: {},
    },
  ],
};

export const CATALOGUE: CatalogProvider[] = [
  {
    id: 'openai',
    synced_at: UPDATED_AT,
    models: [
      {
        id: IDS.model,
        source: 'builtin',
        name: 'gpt-5',
        provider: 'openai',
        display_name: 'GPT-5',
        status: 'available',
        cost_input: 1.25,
        cost_output: 10,
        cost_cache_read: 0.125,
        context_limit: 400_000,
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: true,
        delisted_at: null,
        synced_at: UPDATED_AT,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
      },
    ],
  },
];

export function emptySeries(request: RecordedApiRequest): SeriesResponse {
  const body = (request.body ?? {}) as { interval?: SeriesResponse['interval']; group_by?: SeriesResponse['group_by'] };

  return {
    interval: body.interval ?? 'none',
    group_by: body.group_by ?? [],
    sealed_through: '2026-08-23T12:00:00.000Z',
    points: [],
  };
}

/** Responses needed to visit every page with no application data. */
export function registerEmptyApp(api: ApiMock): void {
  api.get('/api/api-keys', { json: { data: [], meta: PAGE_META } });
  api.get('/api/providers', { json: { data: [] } });
  api.get('/api/prompts', { json: { data: [], meta: PAGE_META } });
  api.get('/api/logs', { json: { data: [], meta: LOG_META } });
  api.get('/api/traces', { json: { data: [], meta: LOG_META } });
  api.get('/api/audit-logs', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks/outbox', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks/deliveries', { json: { data: [], meta: PAGE_META } });
  api.post('/api/analytics/series', (request) => ({ json: emptySeries(request) }));
}
