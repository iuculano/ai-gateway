import type { SeriesResponse } from '../../src/lib/api/analytics';
import type { ApiKey, CatalogProvider, CreatedApiKey, Log, Prompt, PromptVersion } from '../../src/lib/api/types';
import type { ApiMock, RecordedApiRequest } from './api-mock';

export const IDS = {
  apiKey: '0198f100-0000-7000-8000-000000000001',
  prompt: '0198f100-0000-7000-8000-000000000002',
  promptVersion: '0198f100-0000-7000-8000-000000000003',
  successLog: '0198f100-0000-7000-8000-000000000004',
  failedLog: '0198f100-0000-7000-8000-000000000005',
  actor: '0198f100-0000-7000-8000-000000000006',
  model: '0198f100-0000-7000-8000-000000000007',
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
  api.get('/api/audit-logs', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks/outbox', { json: { data: [], meta: PAGE_META } });
  api.get('/api/webhooks/deliveries', { json: { data: [], meta: PAGE_META } });
  api.post('/api/analytics/series', (request) => ({ json: emptySeries(request) }));
}
