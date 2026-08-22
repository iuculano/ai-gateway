/**
 * End-to-end HTTP load harness for the gateway.
 *
 * A deterministic OpenAI-compatible provider is started locally unless
 * --upstream-url is supplied. Requests still pass through the real gateway
 * listener, authentication, Redis, PostgreSQL, and (for full logging) MinIO.
 * Keep the gateway in a separate process: making the load generator share its
 * event loop would make both the offered rate and the result less trustworthy.
 */

import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { connectRedis, redis } from '@repo/redis';
import { SQL } from 'bun';
import { type LoadResult, type RequestSample, reportLoad, runConstantRate } from './load-harness';
import { resolveOrganization } from './seed';

type LoggingMode = 'row' | 'full';
type Protocol = 'nonstream' | 'stream';
type Workload = 'chat' | 'logs' | 'stats' | 'payloads';

interface WeightedWorkload {
  name: Workload;
  weight: number;
}

interface MockOptions {
  hostname: string;
  port: number;
  advertiseHost: string;
  responseDelayMs: number;
  chunkDelayMs: number;
  chunks: number;
  responseBytes: number;
  errorRate: number;
  errorStatus: number;
}

interface MockStats {
  requests: number;
  failed: number;
  active: number;
  peakActive: number;
}

interface TemporaryCredential {
  apiKey: string;
  apiKeyId: string;
  organizationId: string;
  userId: string;
}

const USAGE = `
stress:gateway - send configurable constant-rate HTTP traffic through a running gateway

Target and authentication:
  --gateway-url <url>          gateway origin                         (default: http://127.0.0.1:8080)
  --api-key <aik_...>          existing gateway key                   (default: STRESS_API_KEY)
  --organization <slug|uuid>  tenant for a temporary key             (default: stress)

Load shape:
  --rates <csv>                offered requests/second                (default: 10,50)
  --duration-seconds <n>       measured duration per scenario         (default: 10)
  --warmup-seconds <n>         discarded duration per scenario        (default: 2)
  --concurrency <n>            maximum in-flight requests             (default: 200)
  --logging-modes <csv>        row,full                                (default: row,full)
  --protocols <csv>            nonstream,stream                        (default: nonstream)
  --mix <weights>              chat/logs/stats/payloads traffic       (default: chat:100)
  --logs-query <query>         query string used by the logs workload (default: limit=25)
  --batch-size <n>             ids per payload batch, maximum 100     (default: 25)
  --request-bytes <n>          approximate chat prompt bytes          (default: 256)
  --timeout-ms <n>             per-request client timeout             (default: 30000)

Mock provider (ignored with --upstream-url):
  --upstream-url <url>         use an already-running provider mock
  --provider-api-key <secret>  credential for --upstream-url          (default: STRESS_PROVIDER_API_KEY)
  --model <id>                 provider model/deployment              (default: stress-model)
  --mock-host <host>           local bind address                     (default: 127.0.0.1)
  --mock-advertise-host <host> address the gateway can reach          (default: mock-host)
  --mock-port <n>              local port; 0 chooses a free port      (default: 0)
  --provider-delay-ms <n>      delay before headers/first chunk       (default: 25)
  --provider-chunk-delay-ms <n> delay between streamed chunks         (default: 10)
  --provider-chunks <n>        streamed content chunks                (default: 4)
  --provider-response-bytes <n> approximate generated text bytes      (default: 256)
  --provider-error-rate <0..1> deterministic upstream error fraction (default: 0)
  --provider-error-status <n>  upstream failure status                (default: 503)

Rate-limit correctness burst (disabled when quota is 0):
  --quota <n>                  accepted requests in one window        (default: 0)
  --quota-attempts <n>         simultaneous attempts                  (default: quota * 2)
  --quota-window-seconds <n>   fixed-window duration                  (default: 60)
  --quota-concurrency <n>      burst concurrency                      (default: 200)
  --reset-rate-limit           allow clearing an existing key's live limiter state

Thresholds and output:
  --max-error-rate <0..1>      maximum failures plus dropped arrivals (default: 0.01)
  --max-p95-ms <n>             p95 ceiling; 0 disables                (default: 0)
  --min-rate-ratio <0..1>      minimum successful/target RPS ratio    (default: 0.95)
  --fail-on-thresholds         exit non-zero when a threshold fails
  --out <path>                 append scenario results as JSONL
  --metrics-out <path>         append before/after /metrics snapshots
  --cleanup                    delete logs created by this run through the API
`;

const { values } = parseArgs({
  options: {
    'gateway-url': { type: 'string', default: 'http://127.0.0.1:8080' },
    'api-key': { type: 'string' },
    organization: { type: 'string', default: 'stress' },
    rates: { type: 'string', default: '10,50' },
    'duration-seconds': { type: 'string', default: '10' },
    'warmup-seconds': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '200' },
    'logging-modes': { type: 'string', default: 'row,full' },
    protocols: { type: 'string', default: 'nonstream' },
    mix: { type: 'string', default: 'chat:100' },
    'logs-query': { type: 'string', default: 'limit=25' },
    'batch-size': { type: 'string', default: '25' },
    'request-bytes': { type: 'string', default: '256' },
    'timeout-ms': { type: 'string', default: '30000' },
    'upstream-url': { type: 'string' },
    'provider-api-key': { type: 'string' },
    model: { type: 'string', default: 'stress-model' },
    'mock-host': { type: 'string', default: '127.0.0.1' },
    'mock-advertise-host': { type: 'string' },
    'mock-port': { type: 'string', default: '0' },
    'provider-delay-ms': { type: 'string', default: '25' },
    'provider-chunk-delay-ms': { type: 'string', default: '10' },
    'provider-chunks': { type: 'string', default: '4' },
    'provider-response-bytes': { type: 'string', default: '256' },
    'provider-error-rate': { type: 'string', default: '0' },
    'provider-error-status': { type: 'string', default: '503' },
    quota: { type: 'string', default: '0' },
    'quota-attempts': { type: 'string' },
    'quota-window-seconds': { type: 'string', default: '60' },
    'quota-concurrency': { type: 'string', default: '200' },
    'reset-rate-limit': { type: 'boolean', default: false },
    'max-error-rate': { type: 'string', default: '0.01' },
    'max-p95-ms': { type: 'string', default: '0' },
    'min-rate-ratio': { type: 'string', default: '0.95' },
    'fail-on-thresholds': { type: 'boolean', default: false },
    out: { type: 'string' },
    'metrics-out': { type: 'string' },
    cleanup: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function numberOption(name: string, raw: string, options: { integer?: boolean; minimum?: number } = {}): number {
  const parsed = Number(raw);
  const minimum = options.minimum ?? 0;

  if (!Number.isFinite(parsed) || (options.integer && !Number.isInteger(parsed)) || parsed < minimum) {
    const kind = options.integer ? 'integer' : 'number';
    throw new Error(`--${name} must be a ${kind} greater than or equal to ${minimum}, got "${raw}"`);
  }

  return parsed;
}

function ratioOption(name: string, raw: string): number {
  const parsed = numberOption(name, raw);
  if (parsed > 1) {
    throw new Error(`--${name} must be between 0 and 1, got "${raw}"`);
  }
  return parsed;
}

function csvNumbers(name: string, raw: string): number[] {
  const parsed = raw.split(',').map((entry) => numberOption(name, entry.trim(), { minimum: Number.EPSILON }));
  if (parsed.length === 0) {
    throw new Error(`--${name} must contain at least one value`);
  }
  return parsed;
}

function csvEnum<T extends string>(name: string, raw: string, allowed: readonly T[]): T[] {
  const entries = [...new Set(raw.split(',').map((entry) => entry.trim()))];
  const unknown = entries.filter((entry) => !allowed.includes(entry as T));
  if (entries.length === 0 || unknown.length > 0) {
    throw new Error(`--${name} must contain only ${allowed.join(', ')}, got "${raw}"`);
  }
  return entries as T[];
}

export function parseMix(raw: string): WeightedWorkload[] {
  const allowed: Workload[] = ['chat', 'logs', 'stats', 'payloads'];
  const entries = raw.split(',').map((entry) => {
    const [name, weight, ...rest] = entry.trim().split(':');
    if (!name || !weight || rest.length > 0 || !allowed.includes(name as Workload)) {
      throw new Error(`--mix entries must look like chat:90,logs:10; got "${entry}"`);
    }

    return {
      name: name as Workload,
      weight: numberOption('mix', weight, { integer: true, minimum: 1 }),
    };
  });

  if (entries.length === 0) {
    throw new Error('--mix must contain at least one workload');
  }

  return entries;
}

function pickWorkload(mix: WeightedWorkload[], sequence: number): Workload {
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  // Multiplicative hashing spreads even a short stage across the whole
  // weighted range. Plain sequence % total would make the first 90 requests of
  // chat:90,logs:10 all chat, so a smoke run would never exercise its mix.
  let pick = (Math.imul(sequence, 0x9e3779b1) >>> 0) % total;

  for (const entry of mix) {
    if (pick < entry.weight) {
      return entry.name;
    }
    pick -= entry.weight;
  }

  return mix[0]?.name ?? 'chat';
}

const rates = csvNumbers('rates', values.rates);
const durationSeconds = numberOption('duration-seconds', values['duration-seconds'], { minimum: Number.EPSILON });
const warmupSeconds = numberOption('warmup-seconds', values['warmup-seconds']);
const maxConcurrency = numberOption('concurrency', values.concurrency, { integer: true, minimum: 1 });
const loggingModes = csvEnum<LoggingMode>('logging-modes', values['logging-modes'], ['row', 'full']);
const protocols = csvEnum<Protocol>('protocols', values.protocols, ['nonstream', 'stream']);
const mix = parseMix(values.mix);
const batchSize = numberOption('batch-size', values['batch-size'], { integer: true, minimum: 1 });
if (batchSize > 100) {
  throw new Error(`--batch-size cannot exceed the API maximum of 100, got ${batchSize}`);
}
const requestBytes = numberOption('request-bytes', values['request-bytes'], { integer: true, minimum: 1 });
const timeoutMs = numberOption('timeout-ms', values['timeout-ms'], { integer: true, minimum: 1 });
const quota = numberOption('quota', values.quota, { integer: true });
const quotaAttempts = values['quota-attempts']
  ? numberOption('quota-attempts', values['quota-attempts'], { integer: true, minimum: 1 })
  : quota * 2;
const quotaWindowSeconds = numberOption('quota-window-seconds', values['quota-window-seconds'], {
  integer: true,
  minimum: 1,
});
const quotaConcurrency = numberOption('quota-concurrency', values['quota-concurrency'], {
  integer: true,
  minimum: 1,
});
const maxErrorRate = ratioOption('max-error-rate', values['max-error-rate']);
const maxP95Ms = numberOption('max-p95-ms', values['max-p95-ms']);
const minRateRatio = ratioOption('min-rate-ratio', values['min-rate-ratio']);
const providerApiKey = values['provider-api-key'] ?? process.env.STRESS_PROVIDER_API_KEY ?? 'stress-provider-key';

const gatewayUrl = new URL(values['gateway-url']);
const logIds: string[] = [];
const createdLogIds = new Set<string>();

function gatewayEndpoint(path: string): URL {
  return new URL(path, gatewayUrl);
}

function mockProvider(options: MockOptions): {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  stats: MockStats;
} {
  const encoder = new TextEncoder();
  const stats: MockStats = { requests: 0, failed: 0, active: 0, peakActive: 0 };
  let nextId = 0;

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request) {
      stats.requests++;
      stats.active++;
      stats.peakActive = Math.max(stats.peakActive, stats.active);

      try {
        const sequence = nextId++;
        const body = (await request.json()) as { model?: string; stream?: boolean };
        const id = `chatcmpl-stress-${sequence}`;
        const created = Math.floor(Date.now() / 1000);
        const model = body.model ?? 'stress-model';

        // The quota correctness burst uses a distinct model so configured
        // provider failures do not get mistaken for limiter failures.
        // Sequence zero is the harness preflight. Keep it deterministic even
        // when the measured workload intentionally injects provider failures.
        const canFail = model !== 'stress-quota' && sequence > 0;
        const failureEvery = options.errorRate > 0 ? Math.max(1, Math.round(1 / options.errorRate)) : 0;
        if (canFail && failureEvery > 0 && sequence % failureEvery === 0) {
          stats.failed++;
          await Bun.sleep(options.responseDelayMs);
          return Response.json(
            { error: { message: 'deterministic stress-provider failure', type: 'server_error' } },
            { status: options.errorStatus },
          );
        }

        const text = 'x'.repeat(options.responseBytes);
        const usage = {
          prompt_tokens: 8,
          completion_tokens: Math.max(1, Math.ceil(options.responseBytes / 4)),
          total_tokens: 8 + Math.max(1, Math.ceil(options.responseBytes / 4)),
        };

        if (!body.stream) {
          await Bun.sleep(options.responseDelayMs);
          return Response.json({
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: text, refusal: null },
                logprobs: null,
                finish_reason: 'stop',
              },
            ],
            usage,
          });
        }

        const chunkSize = Math.max(1, Math.ceil(text.length / options.chunks));
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (value: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
            };

            await Bun.sleep(options.responseDelayMs);
            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }],
            });

            for (let offset = 0; offset < text.length; offset += chunkSize) {
              await Bun.sleep(options.chunkDelayMs);
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: text.slice(offset, offset + chunkSize) },
                    logprobs: null,
                    finish_reason: null,
                  },
                ],
              });
            }

            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
              usage,
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      } finally {
        stats.active--;
      }
    },
  });

  return {
    server,
    baseUrl: `http://${options.advertiseHost}:${server.port}/v1`,
    stats,
  };
}

async function provisionCredential(admin: SQL, organizationId: string): Promise<TemporaryCredential> {
  const apiKey = `aik_${randomBytes(30).toString('hex')}`;
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const suffix = randomBytes(6).toString('hex');

  const [user] = await admin`
    insert into users (username, email, name)
    values (${`stress-${suffix}`}, ${`stress-${suffix}@example.test`}, 'Stress Harness')
    returning id
  `;
  if (!user) {
    throw new Error('Failed to provision the stress-harness user');
  }

  const [key] = await admin`
    insert into api_keys (organization_id, name, description, key_hash, creator_id, scopes)
    values (
      ${organizationId},
      ${`stress-${suffix}`},
      'Temporary key created by tests/stress/gateway.stress.ts',
      ${keyHash},
      ${user.id},
      'chat-completions:write logs:read logs:write'
    )
    returning id
  `;
  if (!key) {
    await admin`delete from users where id = ${user.id}`;
    throw new Error('Failed to provision the stress-harness API key');
  }

  return { apiKey, apiKeyId: key.id, organizationId, userId: user.id };
}

async function resolveExistingCredential(
  admin: SQL,
  apiKey: string,
): Promise<Omit<TemporaryCredential, 'userId'> | null> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const [row] = await admin`
    select id, organization_id
    from api_keys
    where key_hash = ${keyHash}
  `;

  return row ? { apiKey, apiKeyId: row.id, organizationId: row.organization_id } : null;
}

function recordLogId(response: Response): string | undefined {
  const id = response.headers.get('ai-log-id') ?? undefined;
  if (id) {
    logIds.push(id);
    createdLogIds.add(id);
    if (logIds.length > 10_000) {
      logIds.splice(0, logIds.length - 10_000);
    }
  }
  return id;
}

function commonHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

async function readResponse(
  response: Response,
  startedAt: number,
  stream: boolean,
): Promise<{ body: string; firstByteMs: number }> {
  if (!stream || !response.body) {
    const firstByteMs = performance.now() - startedAt;
    return { body: await response.text(), firstByteMs };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstByteMs = performance.now() - startedAt;
  let body = first.value ? decoder.decode(first.value, { stream: !first.done }) : '';

  while (!first.done) {
    const next = await reader.read();
    body += next.value ? decoder.decode(next.value, { stream: !next.done }) : '';
    if (next.done) {
      break;
    }
  }

  body += decoder.decode();
  return { body, firstByteMs };
}

interface RequestContext {
  apiKey: string;
  upstreamUrl: string;
  loggingMode: LoggingMode;
  protocol: Protocol;
  sequence: number;
  workload: Workload;
  quotaPolicy?: string;
  model: string;
}

async function performRequest(context: RequestContext): Promise<RequestSample> {
  const startedAt = performance.now();
  const invariantFailures: string[] = [];
  let response: Response;
  let body = '';
  let firstByteMs: number | undefined;

  try {
    if (context.workload === 'chat') {
      const headers = new Headers(commonHeaders(context.apiKey));
      headers.set('Content-Type', 'application/json');
      headers.set('ai-api-key', providerApiKey);
      headers.set('ai-base-url', context.upstreamUrl);
      headers.set('ai-max-retries', '0');
      if (context.quotaPolicy) {
        headers.set('ai-rate-limit-policy', context.quotaPolicy);
      }
      if (context.loggingMode === 'row') {
        headers.set('ai-log-omit-request', 'true');
        headers.set('ai-log-omit-response', 'true');
      }

      response = await fetch(gatewayEndpoint('/v1/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: context.model,
          messages: [{ role: 'user', content: 'p'.repeat(requestBytes) }],
          stream: context.protocol === 'stream',
          ...(context.protocol === 'stream' ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Every mode writes the row that carries the accounting, so every OK
      // response has a log to point at.
      const logId = recordLogId(response);
      if (response.ok && !logId) {
        invariantFailures.push(`${context.loggingMode} response omitted ai-log-id`);
      }

      const read = await readResponse(response, startedAt, context.protocol === 'stream');
      body = read.body;
      firstByteMs = read.firstByteMs;

      if (response.ok && context.protocol === 'stream' && !body.includes('data: [DONE]')) {
        invariantFailures.push('stream ended without [DONE]');
      }
      if (response.ok && context.protocol === 'nonstream') {
        try {
          JSON.parse(body);
        } catch {
          invariantFailures.push('non-stream response was not JSON');
        }
      }
    } else if (context.workload === 'logs') {
      const url = gatewayEndpoint('/v1/logs');
      url.search = values['logs-query'];
      response = await fetch(url, {
        headers: commonHeaders(context.apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const read = await readResponse(response, startedAt, false);
      body = read.body;
      firstByteMs = read.firstByteMs;
    } else if (context.workload === 'stats') {
      response = await fetch(gatewayEndpoint('/v1/logs/stats'), {
        headers: commonHeaders(context.apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const read = await readResponse(response, startedAt, false);
      body = read.body;
      firstByteMs = read.firstByteMs;
    } else {
      const ids = logIds.slice(-batchSize);
      if (ids.length === 0) {
        // The first payload arrival can race ahead of the first completed chat.
        // A logs read is useful work and avoids sending a deliberately invalid
        // empty batch merely because the workload is still warming up.
        return performRequest({ ...context, workload: 'logs' });
      }

      response = await fetch(gatewayEndpoint('/v1/logs/batch/response'), {
        method: 'POST',
        headers: { ...commonHeaders(context.apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const read = await readResponse(response, startedAt, false);
      body = read.body;
      firstByteMs = read.firstByteMs;

      if (response.ok && context.loggingMode === 'full') {
        try {
          const parsed = JSON.parse(body) as { meta?: { returned?: number } };
          if (parsed.meta?.returned !== ids.length) {
            invariantFailures.push(`full payload batch returned ${parsed.meta?.returned ?? 0}/${ids.length}`);
          }
        } catch {
          invariantFailures.push('payload batch response was not JSON');
        }
      }
    }
  } catch (error) {
    return {
      status: 0,
      latencyMs: performance.now() - startedAt,
      ...(firstByteMs === undefined ? {} : { firstByteMs }),
      error: error instanceof Error ? error.message : String(error),
      invariantFailures,
    };
  }

  return {
    status: response.status,
    latencyMs: performance.now() - startedAt,
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(!response.ok ? { error: `HTTP ${response.status}: ${body.replaceAll(/\s+/g, ' ').slice(0, 180)}` } : {}),
    invariantFailures,
  };
}

async function mapConcurrent<T>(count: number, concurrency: number, run: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < count) {
      const index = next++;
      results[index] = await run(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
  return results;
}

async function snapshotMetrics(label: string): Promise<{ label: string; at: string; body?: string; error?: string }> {
  try {
    const response = await fetch(gatewayEndpoint('/metrics'), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { label, at: new Date().toISOString(), error: `HTTP ${response.status}` };
    }
    return { label, at: new Date().toISOString(), body: await response.text() };
  } catch (error) {
    return { label, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
  }
}

async function append(path: string, contents: string): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  await Bun.write(path, `${existing}${contents}`);
}

let admin: SQL | undefined;
let credential: TemporaryCredential | Omit<TemporaryCredential, 'userId'> | undefined;
let temporaryCredential: TemporaryCredential | undefined;
let redisConnected = false;
let mock: ReturnType<typeof mockProvider> | undefined;
const results: LoadResult[] = [];
const thresholdFailures: string[] = [];

try {
  let apiKey = values['api-key'] ?? process.env.STRESS_API_KEY;
  const adminConnectionString = process.env.POSTGRES_ADMIN_CONNECTION_STRING;

  if (!apiKey) {
    if (!adminConnectionString) {
      throw new Error(
        'No --api-key or STRESS_API_KEY was supplied and POSTGRES_ADMIN_CONNECTION_STRING is unset, so a temporary key cannot be provisioned.',
      );
    }

    admin = new SQL(adminConnectionString);
    const organization = await resolveOrganization(admin, values.organization);
    temporaryCredential = await provisionCredential(admin, organization.id);
    credential = temporaryCredential;
    apiKey = temporaryCredential.apiKey;
    console.log(`credential    temporary key for ${organization.slug} (${organization.id})`);
  } else if (quota > 0) {
    if (!adminConnectionString) {
      throw new Error(
        '--quota with an existing key requires POSTGRES_ADMIN_CONNECTION_STRING to resolve its limiter key',
      );
    }
    if (!values['reset-rate-limit']) {
      throw new Error(
        '--quota with an existing key requires --reset-rate-limit; use a temporary key to avoid touching live state',
      );
    }

    admin = new SQL(adminConnectionString);
    const existingCredential = await resolveExistingCredential(admin, apiKey);
    if (!existingCredential) {
      throw new Error('The supplied API key does not exist in POSTGRES_ADMIN_CONNECTION_STRING');
    }
    credential = existingCredential;
  }

  const mockOptions: MockOptions = {
    hostname: values['mock-host'],
    port: numberOption('mock-port', values['mock-port'], { integer: true }),
    advertiseHost: values['mock-advertise-host'] ?? values['mock-host'],
    responseDelayMs: numberOption('provider-delay-ms', values['provider-delay-ms']),
    chunkDelayMs: numberOption('provider-chunk-delay-ms', values['provider-chunk-delay-ms']),
    chunks: numberOption('provider-chunks', values['provider-chunks'], { integer: true, minimum: 1 }),
    responseBytes: numberOption('provider-response-bytes', values['provider-response-bytes'], {
      integer: true,
      minimum: 1,
    }),
    errorRate: ratioOption('provider-error-rate', values['provider-error-rate']),
    errorStatus: numberOption('provider-error-status', values['provider-error-status'], {
      integer: true,
      minimum: 400,
    }),
  };
  if (mockOptions.errorStatus > 599) {
    throw new Error(`--provider-error-status cannot exceed 599, got ${mockOptions.errorStatus}`);
  }

  if (!values['upstream-url']) {
    mock = mockProvider(mockOptions);
  }
  const upstreamUrl = values['upstream-url'] ?? mock?.baseUrl;
  if (!upstreamUrl) {
    throw new Error('Failed to resolve an upstream provider URL');
  }

  console.log(`gateway       ${gatewayUrl}`);
  console.log(`upstream      ${upstreamUrl}${mock ? ' (local deterministic mock)' : ''}`);
  console.log(`rates         ${rates.join(', ')} RPS for ${durationSeconds}s each`);
  console.log(`modes         ${loggingModes.join(', ')}`);
  console.log(`protocols     ${protocols.join(', ')}`);
  console.log(`mix           ${mix.map((entry) => `${entry.name}:${entry.weight}`).join(', ')}`);

  const preflight = await performRequest({
    apiKey,
    upstreamUrl,
    loggingMode: 'row',
    protocol: 'nonstream',
    workload: 'chat',
    sequence: -1,
    model: values.model,
  });
  if (preflight.status !== 200) {
    throw new Error(`Gateway preflight failed: ${preflight.error ?? `HTTP ${preflight.status}`}`);
  }

  const metricsBefore = await snapshotMetrics('before');

  for (const loggingMode of loggingModes) {
    for (const protocol of protocols) {
      for (const rate of rates) {
        const name = `${loggingMode}/${protocol}/${rate}rps`;
        const run = (sequence: number) =>
          performRequest({
            apiKey,
            upstreamUrl,
            loggingMode,
            protocol,
            workload: pickWorkload(mix, sequence),
            sequence,
            model: values.model,
          });

        if (warmupSeconds > 0) {
          process.stdout.write(`warming       ${name}\n`);
          await runConstantRate({
            name: `${name} warmup`,
            ratePerSecond: rate,
            durationSeconds: warmupSeconds,
            maxConcurrency,
            run,
          });
        }

        process.stdout.write(`measuring     ${name}\n`);
        const result = await runConstantRate({
          name,
          ratePerSecond: rate,
          durationSeconds,
          maxConcurrency,
          run,
        });
        results.push(result);

        const successfulRps = result.succeeded / result.duration_seconds;
        if (result.error_rate > maxErrorRate) {
          thresholdFailures.push(
            `${name}: error rate ${(result.error_rate * 100).toFixed(2)}% exceeds ${(maxErrorRate * 100).toFixed(2)}%`,
          );
        }
        if (maxP95Ms > 0 && result.latency_ms.p95 > maxP95Ms) {
          thresholdFailures.push(`${name}: p95 ${result.latency_ms.p95.toFixed(1)}ms exceeds ${maxP95Ms}ms`);
        }
        if (successfulRps < rate * minRateRatio) {
          thresholdFailures.push(
            `${name}: successful rate ${successfulRps.toFixed(1)} RPS is below ${(rate * minRateRatio).toFixed(1)} RPS`,
          );
        }
        if (Object.keys(result.invariant_failures).length > 0) {
          thresholdFailures.push(`${name}: ${JSON.stringify(result.invariant_failures)}`);
        }
      }
    }
  }

  const metricsAfter = await snapshotMetrics('after');

  console.log(`\n${reportLoad(results)}`);

  for (const result of results) {
    const details = [
      Object.keys(result.statuses).length > 1 ? `statuses=${JSON.stringify(result.statuses)}` : '',
      Object.keys(result.errors).length > 0 ? `errors=${JSON.stringify(result.errors)}` : '',
      Object.keys(result.invariant_failures).length > 0
        ? `invariants=${JSON.stringify(result.invariant_failures)}`
        : '',
    ].filter(Boolean);
    if (details.length > 0) {
      console.log(`${result.name}: ${details.join(' ')}`);
    }
  }

  if (quota > 0) {
    if (!credential) {
      throw new Error('The quota burst needs a resolvable API-key identity');
    }

    await connectRedis();
    redisConnected = true;
    const limiterKey = `chat-completions:${credential.organizationId}:${credential.apiKeyId}`;
    await redis.del(limiterKey);

    console.log(`\nquota burst   ${quotaAttempts} attempts, quota ${quota};w=${quotaWindowSeconds}`);
    const quotaSamples = await mapConcurrent(quotaAttempts, quotaConcurrency, (sequence) =>
      performRequest({
        apiKey,
        upstreamUrl,
        loggingMode: 'row',
        protocol: 'nonstream',
        workload: 'chat',
        sequence,
        quotaPolicy: `${quota};w=${quotaWindowSeconds}`,
        model: mock ? 'stress-quota' : values.model,
      }),
    );
    const accepted = quotaSamples.filter((sample) => sample.status === 200).length;
    const limited = quotaSamples.filter((sample) => sample.status === 429).length;
    const other = quotaSamples.length - accepted - limited;
    const expectedAccepted = Math.min(quota, quotaAttempts);
    const expectedLimited = Math.max(0, quotaAttempts - quota);
    console.log(`quota result  accepted=${accepted} limited=${limited} other=${other}`);

    if (accepted !== expectedAccepted || limited !== expectedLimited || other !== 0) {
      thresholdFailures.push(
        `quota burst: expected accepted=${expectedAccepted}, limited=${expectedLimited}, other=0; ` +
          `got accepted=${accepted}, limited=${limited}, other=${other}`,
      );
    }

    await redis.del(limiterKey);
  }

  if (values.out) {
    const at = new Date().toISOString();
    await append(values.out, `${results.map((result) => JSON.stringify({ at, ...result })).join('\n')}\n`);
    console.log(`\nappended ${results.length} results to ${values.out}`);
  }

  if (values['metrics-out']) {
    await append(
      values['metrics-out'],
      [metricsBefore, metricsAfter]
        .map((snapshot) =>
          snapshot.body
            ? `# stress snapshot ${snapshot.label} ${snapshot.at}\n${snapshot.body.trimEnd()}\n`
            : `# stress snapshot ${snapshot.label} ${snapshot.at} ERROR ${snapshot.error}\n`,
        )
        .join(''),
    );
    console.log(`appended metrics snapshots to ${values['metrics-out']}`);
  }

  if (mock) {
    console.log(
      `provider      requests=${mock.stats.requests} failed=${mock.stats.failed} peak_active=${mock.stats.peakActive}`,
    );
  }

  if (thresholdFailures.length > 0) {
    console.log('\nthreshold failures:');
    for (const failure of thresholdFailures) {
      console.log(`  ${failure}`);
    }
    if (values['fail-on-thresholds']) {
      process.exitCode = 1;
    }
  }

  if (values.cleanup && createdLogIds.size > 0) {
    console.log(`\ncleanup       deleting ${createdLogIds.size.toLocaleString('en-US')} logs`);
    const ids = [...createdLogIds];
    const cleanupSamples = await mapConcurrent(ids.length, Math.min(maxConcurrency, 32), async (index) => {
      const id = ids[index] as string;
      const response = await fetch(gatewayEndpoint(`/v1/logs/${id}`), {
        method: 'DELETE',
        headers: commonHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.status;
    });
    const cleanupFailures = cleanupSamples.filter((status) => status !== 204 && status !== 404).length;
    console.log(`cleanup       failures=${cleanupFailures}`);
    if (cleanupFailures > 0 && values['fail-on-thresholds']) {
      process.exitCode = 1;
    }
  }
} finally {
  mock?.server.stop(true);

  if (temporaryCredential) {
    try {
      if (!redisConnected) {
        await connectRedis();
        redisConnected = true;
      }
      await redis.del([
        `api-keys:auth:v1:${createHash('sha256').update(temporaryCredential.apiKey).digest('hex')}`,
        `api-keys:usage:${temporaryCredential.apiKeyId}`,
        `api-keys:quota:${temporaryCredential.apiKeyId}`,
        `chat-completions:${temporaryCredential.organizationId}:${temporaryCredential.apiKeyId}`,
      ]);
    } catch {
      // Best-effort cleanup: a Redis outage should not hide the load result.
    }
  }

  if (temporaryCredential && admin) {
    await admin`delete from api_keys where id = ${temporaryCredential.apiKeyId}`.catch(() => {});
    await admin`delete from users where id = ${temporaryCredential.userId}`.catch(() => {});
  }
  await admin?.close();

  if (redisConnected) {
    await redis.close();
  }
}
