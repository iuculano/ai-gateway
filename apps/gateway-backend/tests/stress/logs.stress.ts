/**
 * Read-path stress harness for inference logs.
 *
 * Seeds a chosen number of synthetic log rows, then measures the queries whose
 * cost is a function of how many rows exist. Run it repeatedly at increasing
 * sizes - the point is the curve, not any single number:
 *
 *   bun run stress:logs -- --count 20000
 *   bun run stress:logs -- --count 80000    # 100k total
 *   bun run stress:logs -- --count 400000   # 500k total
 *
 * Each run ADDS to what is already there, so the sizes above accumulate. Pass
 * --out results.jsonl to collect the rows and diff the curve afterwards.
 *
 * Everything is measured at the SERVICE layer through the application role, so
 * the SQL, organization predicates, index choices and the zod parse of every
 * returned row are all in the measurement.
 * The HTTP layer above it is deliberately not: authentication, routing and JSON
 * serialization cost the same at twenty thousand rows as at two million,
 * because they scale with the PAGE, and a page is capped at 250. Putting them
 * in would add a constant to every column and obscure the thing that actually
 * moves.
 *
 * By default this seeds into an organization called `stress`, created on
 * demand, so it cannot dump synthetic rows in front of whoever opens the
 * dashboard next. Point it at a real tenant with --organization <slug> when
 * that is what you want; --reset removes only rows carrying the seed tag, so
 * that tenant's genuine logs are never at risk.
 */

import { parseArgs } from 'node:util';
import { createCacheKey } from '@repo/core';
import { db, sql } from '@repo/drizzle';
import { type Caller, runWithCaller } from '@repo/hono';
import { connectRedis, redis } from '@repo/redis';
import { SQL } from 'bun';
import AnalyticsServices from '../../src/api/analytics/analytics.services';
import LogsServices from '../../src/api/logs/logs.services';
import { commonestModel, rarestModel } from './catalogue';
import { measure, type Result, report, type Scenario } from './harness';
import {
  ABSENT_ENV_TAG,
  COMMON_ENV_TAG,
  countLogs,
  deleteSeededLogs,
  findBorrowablePayloads,
  RARE_ENV_TAG,
  resolveOrganization,
  seedLogs,
} from './seed';

const USAGE = `
stress:logs - seed inference logs and measure the read paths that scale with them

  --organization <slug|uuid>  tenant to seed and measure   (default: stress, created on demand)
  --count <n>                 rows to ADD this run         (default: 20000)
  --window-days <n>           age of the oldest new row    (default: 30)
  --chunk <n>                 rows per insert statement    (default: 25000)
  --iterations <n>            measured runs per scenario   (default: 25)
  --warmup <n>                discarded runs per scenario  (default: 3)
  --out <path>                append results as JSONL
  --explain                   print query plans after the table
  --borrow-payloads           point seeded rows at a real log's stored payloads
  --skip-seed                 measure what is already there
  --reset                     delete this tenant's seeded rows, then exit
`;

const { values } = parseArgs({
  options: {
    organization: { type: 'string', default: 'stress' },
    count: { type: 'string', default: '20000' },
    'window-days': { type: 'string', default: '30' },
    chunk: { type: 'string', default: '25000' },
    iterations: { type: 'string', default: '25' },
    warmup: { type: 'string', default: '3' },
    out: { type: 'string' },
    explain: { type: 'boolean', default: false },
    'borrow-payloads': { type: 'boolean', default: false },
    'skip-seed': { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

/**
 * Transient status line.
 *
 * Overwrites itself on a terminal and falls back to ordinary lines when stdout
 * is a pipe - carriage returns into a log file produce one unreadable smear,
 * and redirecting the output of a run that takes minutes is the normal way to
 * use this.
 */
function progress(message: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${message.padEnd(72)}`);
    return;
  }

  console.log(message);
}

/** Clears the status line, if there is one to clear. */
function clearProgress(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${' '.repeat(72)}\r`);
  }
}

function integer(name: string, raw: string): number {
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${raw}"`);
  }

  return parsed;
}

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name} is unset, so there is nothing to stress.\n\n` +
        '  docker compose up -d postgres valkey\n' +
        '  bun run --cwd packages/drizzle db:push\n\n' +
        'Both connection strings are in apps/backend/.env.example.',
    );
  }

  return value;
}

const applicationConnectionString = required('POSTGRES_CONNECTION_STRING');
const adminConnectionString = required('POSTGRES_ADMIN_CONNECTION_STRING');

/**
 * The two connections must name the same database.
 *
 * Seeding runs as the superuser and measuring runs as app_user, which is the
 * whole design - but it also means a mismatched pair produces a harness that
 * cheerfully seeds one database and benchmarks an empty other one. That failure
 * looks like excellent performance.
 */
{
  const application = new URL(applicationConnectionString);
  const admin = new URL(adminConnectionString);

  if (application.host !== admin.host || application.pathname !== admin.pathname) {
    throw new Error(
      'POSTGRES_CONNECTION_STRING and POSTGRES_ADMIN_CONNECTION_STRING point at different databases ' +
        `(${application.host}${application.pathname} vs ${admin.host}${admin.pathname}). ` +
        'The harness seeds through one and measures through the other, so they must match.',
    );
  }
}

const admin = new SQL(adminConnectionString);

const organization = await resolveOrganization(admin, values.organization);
const caller: Caller = {
  organization: { id: organization.id, name: organization.slug },
  actor: {
    type: 'user',
    user: {
      id: organization.id,
      username: 'stress-harness',
      email: 'stress-harness@example.test',
    },
  },
  permissions: { scopes: [] },
  request: {},
};

function asTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(caller, work);
}

if (values.reset) {
  const removed = await deleteSeededLogs(admin, organization.id);
  console.log(`removed ${removed.toLocaleString('en-US')} seeded logs from ${organization.slug}`);
  await admin.close();
  process.exit(0);
}

const count = integer('count', values.count);
const iterations = integer('iterations', values.iterations);
const warmup = integer('warmup', values.warmup);

console.log(`organization  ${organization.slug} (${organization.id})`);
console.log(`database      ${new URL(applicationConnectionString).pathname.replace(/^\//, '')}`);

if (!values['skip-seed'] && count > 0) {
  const startedAt = performance.now();

  // Resolved before the first insert rather than per chunk, so a run either
  // borrows throughout or fails before writing anything - half a seed pointing
  // at real objects and half at nothing would be worse than either.
  const payloads = values['borrow-payloads'] ? await findBorrowablePayloads(admin, organization.id) : undefined;

  if (values['borrow-payloads'] && !payloads) {
    throw new Error(
      `--borrow-payloads found no log in "${organization.slug}" with both payloads stored, so there is ` +
        'nothing to borrow. Only logs the gateway actually wrote have objects behind them - make one ' +
        'inference request against this tenant, or drop the flag and accept rows whose payloads 404.',
    );
  }

  if (payloads) {
    console.log(`payloads      borrowed from ${payloads.request}`);
  }

  await seedLogs(admin, {
    organizationId: organization.id,
    count: count,
    windowDays: integer('window-days', values['window-days']),
    chunkSize: integer('chunk', values.chunk),
    payloads: payloads,
    onProgress: (inserted, total) => {
      progress(`seeding       ${inserted.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`);
    },
  });

  const elapsed = (performance.now() - startedAt) / 1000;
  clearProgress();

  const perSecond = Math.round(count / Math.max(elapsed, 0.001)).toLocaleString('en-US');
  console.log(`seeding       ${count.toLocaleString('en-US')} rows in ${elapsed.toFixed(1)}s (${perSecond}/s)`);
}

const total = await countLogs(admin, organization.id);
console.log(`total logs    ${total.toLocaleString('en-US')}\n`);

if (total === 0) {
  throw new Error('The organization holds no logs, so there is nothing to measure. Drop --skip-seed.');
}

/**
 * A cursor deep into the set.
 *
 * Read once, before measuring, rather than walked to on every iteration. The
 * question a deep cursor answers is "does page 800 cost more than page 1" - so
 * the measurement has to be ONE query at that depth. Walking there each time
 * would measure eight hundred queries and answer a question nobody asked.
 *
 * 90% of the way down, so it is genuinely deep at any size.
 */
const deepOffset = Math.floor(total * 0.9);
const [deep] = await admin`
  select id from logs
  where organization_id = ${organization.id}
  order by id desc
  offset ${deepOffset}
  limit 1
`;

const deepCursor: string | undefined = deep?.id;

// Analytics reaches redis before it reaches postgres, so the connection has to
// be open or every one of those scenarios rejects on the first call.
await connectRedis();

const common = commonestModel();
const rare = rarestModel();

/** Runs `listLogs` as the selected tenant and reports how many rows came back. */
function list(name: string, query: Parameters<typeof LogsServices.listLogs>[0]): Scenario {
  return {
    name: name,
    run: async () => {
      const page = await asTenant(() => LogsServices.listLogs(query));

      return page.data.length;
    },
  };
}

/**
 * Runs `queryAnalytics`, defeating its own cache first.
 *
 * The service caches for five minutes, so measuring it as-is would time one
 * real aggregate and then twenty-four redis GETs - a flat line that stays flat
 * no matter how many rows exist, which is the opposite of what this harness is
 * for. Deleting the key reproduces the cold path every iteration.
 *
 * Reported `rows` is total_logs, not the row count of the result set - the
 * result is always one row. A total_logs of 0 against a seeded tenant means the
 * service's explicit organization filter is wrong rather than the query being
 * unexpectedly fast.
 */
function analytics(name: string, body: Parameters<typeof AnalyticsServices.queryAnalytics>[0]): Scenario {
  const cacheKey = createCacheKey('analytics:', { organization_id: organization.id, ...body });

  return {
    name: name,
    run: async () => {
      await redis.del(cacheKey);

      const result = await asTenant(() => AnalyticsServices.queryAnalytics(body));

      return result.total_logs;
    },
  };
}

const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const scenarios: Scenario[] = [
  list('list head (limit 25)', { limit: 25 }),
  list('list head (limit 250)', { limit: 250 }),

  ...(deepCursor
    ? [list(`list after_id @ ${deepOffset.toLocaleString('en-US')}`, { limit: 25, after_id: deepCursor })]
    : []),

  list(`list model=${common.model} (common)`, { limit: 25, model: common.model }),
  list(`list model=${rare.model} (rare)`, { limit: 25, model: rare.model }),
  list('list status=failed', { limit: 25, status: 'failed' }),
  list(`list tags env:${COMMON_ENV_TAG} (common)`, { limit: 25, tags: `env:${COMMON_ENV_TAG}` }),
  list(`list tags env:${RARE_ENV_TAG} (rare)`, { limit: 25, tags: `env:${RARE_ENV_TAG}` }),

  // The pair below is the point of this whole section.
  //
  // Both filters match nothing, and both are one typo away in the dashboard's
  // filter box - but `model` is covered by logs_org_model_idx and `tags` is
  // not, in any way the planner will use here. The indexed one answers in
  // microseconds; the tag one walks every row in the table before it can say
  // "none", and that walk is the only cost in this harness that grows with the
  // size being tested. Measuring them side by side is what makes the
  // difference impossible to argue with.
  list('list model=absent (no matches)', { limit: 25, model: '__no_such_model__' }),
  list(`list tags env:${ABSENT_ENV_TAG} (no matches)`, { limit: 25, tags: `env:${ABSENT_ENV_TAG}` }),

  {
    // Not an endpoint. It is here because "show the total" is the first thing
    // anyone adds to a dashboard, and it is the one read whose cost is O(rows)
    // with no cursor to save it.
    name: 'count(*) for tenant',
    run: async () => {
      const rows = await db.execute<{ total: number }>(
        sql`select count(*)::int as total from logs where organization_id = ${organization.id}`,
      );

      return rows[0]?.total ?? 0;
    },
  },

  analytics('analytics (all time)', {}),
  analytics('analytics (last 24h)', { start_date: dayAgo }),
  analytics(`analytics (model=${common.model})`, { model: common.model }),
];

const results: Result[] = [];

for (const scenario of scenarios) {
  progress(`measuring     ${scenario.name}`);
  results.push(await measure(scenario, { warmup: warmup, iterations: iterations }));
}

clearProgress();
console.log(`${iterations} iterations per scenario, ${warmup} discarded\n`);
console.log(report(results));

/**
 * Plans for the queries whose shape decides everything above.
 *
 * These are hand-written mirrors of the SQL the services emit, not the emitted
 * SQL itself - drizzle builds it inside the service and there is no seam to
 * capture it through. Keep them in step with logs.services.ts if the filters
 * change; their only job is to answer "is postgres using the index, or has it
 * given up and started scanning".
 *
 * Run through the application connection and carry the same organization
 * predicate as the service queries, so the plans exercise the production
 * indexes and query shape.
 */
if (values.explain) {
  const probes: Array<{ name: string; statement: ReturnType<typeof sql> }> = [
    {
      name: 'listLogs head',
      statement: sql`
        explain (analyze, buffers)
        select * from logs
        where organization_id = ${organization.id}
        order by id desc
        limit 26
      `,
    },
    {
      name: `listLogs tags env:${RARE_ENV_TAG}`,
      statement: sql`
        explain (analyze, buffers)
        select * from logs
        where organization_id = ${organization.id}
          and tags @> ${{ env: RARE_ENV_TAG }}::jsonb
        order by id desc
        limit 26
      `,
    },
    {
      name: 'analytics aggregate',
      statement: sql`
        explain (analyze, buffers)
        select
          count(*),
          percentile_cont(0.95) within group (order by response_time_ms),
          coalesce(sum(input_cost), 0) + coalesce(sum(output_cost), 0)
        from logs
        where organization_id = ${organization.id}
      `,
    },
  ];

  for (const probe of probes) {
    console.log(`\n--- ${probe.name} ---`);

    const rows = await db.execute<Record<string, unknown>>(probe.statement);

    for (const row of rows) {
      console.log(Object.values(row)[0]);
    }
  }
}

if (values.out) {
  // Appended rather than rewritten: the whole point is comparing this run to
  // the smaller ones before it.
  const at = new Date().toISOString();

  const lines = results
    .map((result) =>
      JSON.stringify({
        at: at,
        organization: organization.slug,
        total_logs: total,
        ...result,
      }),
    )
    .join('\n');

  const file = Bun.file(values.out);
  const existing = (await file.exists()) ? await file.text() : '';

  await Bun.write(values.out, `${existing}${lines}\n`);
  console.log(`\nappended ${results.length} rows to ${values.out}`);
}

await admin.close();
await redis.close();
