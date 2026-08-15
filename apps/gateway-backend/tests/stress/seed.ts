import type { SQL } from 'bun';
import { TEAMS, weightedCatalogue } from './catalogue';

/**
 * Bulk-generates inference log rows.
 *
 * Rows are generated INSIDE postgres, from `generate_series`, rather than built
 * in TypeScript and shipped over the wire. At the sizes this harness exists for
 * that is the difference between a seed that takes seconds and one that takes
 * minutes: a million-row insert becomes twenty round trips carrying a few
 * hundred bytes each, instead of a million parameter bindings.
 *
 * Everything here runs on the ADMIN connection because bulk seeding is setup,
 * not the thing under test. Measurements use the application role and the same
 * explicit organization predicates as production queries.
 */

/**
 * The tag every seeded row carries.
 *
 * This is what makes seeding into a real organization safe. Cleanup is
 * `where tags @> '{"seed":"stress"}'`, which cannot match a log the gateway
 * actually wrote - the ingestion path never sets this key. Without it, removing
 * test data from an organization that also holds real logs would mean deleting
 * by timestamp and hoping.
 */
export const SEED_TAG_KEY = 'seed';
export const SEED_TAG_VALUE = 'stress';

/** The `env` tag distribution, as cumulative thresholds against random(). */
const ENV_BUCKETS = [
  // Deliberately ~0.1%. The high-selectivity case for the GIN index: a tag
  // filter that matches a handful of rows out of however many exist.
  { value: 'canary', below: 0.001 },
  { value: 'dev', below: 0.2 },
  { value: 'staging', below: 0.45 },
  { value: 'prod', below: 1 },
];

/** Each bucket's actual share, recovered from the cumulative thresholds. */
function envShares(): Array<{ value: string; share: number }> {
  return ENV_BUCKETS.map((bucket, index) => ({
    value: bucket.value,
    share: bucket.below - (ENV_BUCKETS[index - 1]?.below ?? 0),
  }));
}

/**
 * The two ends of the tag selectivity range.
 *
 * Derived from the buckets rather than written out beside them, for the reason
 * rarestModel() is: reweight the distribution above and the scenarios follow it
 * instead of quietly measuring the wrong end of it.
 */
export const RARE_ENV_TAG = envShares().reduce((rarest, bucket) =>
  bucket.share < rarest.share ? bucket : rarest,
).value;

export const COMMON_ENV_TAG = envShares().reduce((commonest, bucket) =>
  bucket.share > commonest.share ? bucket : commonest,
).value;

/**
 * An `env` value nothing is ever seeded with.
 *
 * The worst case, and a trivially reachable one - it is what the dashboard
 * sends the moment somebody mistypes a tag filter. A filter that matches
 * nothing cannot stop early, so it is the scenario where the cost of the plan
 * is paid in full.
 */
export const ABSENT_ENV_TAG = 'nonexistent';

/** A pair of object keys that already resolve. */
export interface BorrowedPayloads {
  request: string;
  response: string;
}

export interface SeedOptions {
  organizationId: string;

  /** How many rows to add. */
  count: number;

  /** How far back the oldest seeded row is dated. */
  windowDays: number;

  /** Rows per INSERT statement. */
  chunkSize: number;

  /**
   * Object keys to point every seeded row at, instead of per-row synthetic
   * ones.
   *
   * Every row ends up advertising the SAME two objects, which is nonsense as
   * data and exactly right as a fixture: it is the difference between a
   * dashboard where opening a row shows a conversation and one where every row
   * 404s. Nothing in the read paths cares that the keys repeat - the service
   * takes the key off the row it just read, so one object serves any number of
   * rows.
   *
   * Omit it and rows get synthetic keys pointing at objects that were never
   * written. Fine for measuring list and aggregate queries, which never touch
   * object storage; useless for looking at.
   */
  payloads?: BorrowedPayloads;

  onProgress?: (inserted: number, total: number) => void;
}

/**
 * The insert, as one statement per chunk.
 *
 * Two things in here are worth explaining.
 *
 * `uuidv7(created_at - clock_timestamp())` is what keeps the ids and the
 * timestamps telling the same story. Postgres 18's uuidv7() takes an interval
 * that shifts the timestamp it embeds, so this produces an id whose embedded
 * time IS the row's created_at. That matters because listLogs orders by id and
 * pages on it while the dashboard renders created_at: seed those independently
 * and the newest-first list arrives in an order the timestamp column
 * contradicts, and every cursor measurement is walking an ordering production
 * would never produce.
 *
 * The nulls are not decoration either. An 'incomplete' row is one that died
 * before the provider answered, so it has no tokens, no latency and no stored
 * payload; a 'failed' row has a request but no response. Seeding those columns
 * full would make `avg(response_time_ms)` and the percentile aggregates read
 * over a denser column than they ever see in production, and would make
 * has_request/has_response uniformly true.
 */
/**
 * The env CASE, generated from ENV_BUCKETS so the thresholds have one home.
 *
 * Interpolated into SQL rather than bound, because a CASE arm is structure
 * rather than a value and cannot be parameterised. Safe here and only here:
 * every part of it comes from the literal array above, none of it from input.
 */
const ENV_CASE = `case
      ${ENV_BUCKETS.map((bucket) => `when s.env_roll < ${bucket.below} then '${bucket.value}'`).join('\n      ')}
    end`;

const INSERT = `
-- ($n::text)::jsonb, never $n::jsonb. Bun's driver binds a JS string as a JSON
-- value, so casting it straight to jsonb produces a jsonb STRING - the whole
-- array arrives as one scalar and jsonb_array_elements refuses it with "cannot
-- extract elements from a scalar". Routing through ::text is what makes
-- postgres parse the contents rather than quote them.
with
catalogue as (
  select
    ord::int                        as pick,
    entry->>'model'                 as model,
    entry->>'provider'              as provider,
    (entry->>'cost_input')::numeric  as cost_input,
    (entry->>'cost_output')::numeric as cost_output
  from jsonb_array_elements(($4::text)::jsonb) with ordinality as t(entry, ord)
),
teams as (
  select ord::int as pick, value as team
  from jsonb_array_elements_text(($5::text)::jsonb) with ordinality as t(value, ord)
),
series as (
  select
    $2::timestamptz + ((i * $3::double precision) * interval '1 millisecond') as created_at,
    (floor(random() * (select count(*) from catalogue)) + 1)::int             as catalogue_pick,
    (floor(random() * (select count(*) from teams)) + 1)::int                 as team_pick,
    random() as status_roll,
    random() as env_roll,
    random() as latency_roll,
    random() as input_roll,
    random() as output_roll
  from generate_series($6::bigint, $7::bigint) as i
),
shaped as (
  select
    uuidv7(s.created_at - clock_timestamp()) as id,
    s.created_at,
    c.model,
    c.provider,
    c.cost_input,
    c.cost_output,
    t.team,
    case
      when s.status_roll < 0.03 then 'failed'
      when s.status_roll < 0.04 then 'incomplete'
      else 'complete'
    end as status,
    ${ENV_CASE} as env,

    -- Squared and cubed rolls rather than a flat random(): token counts and
    -- especially latencies are long-tailed, and a uniform response_time_ms
    -- makes p50, p95 and p99 land almost on top of each other - which would
    -- make the analytics percentiles look like they were measuring nothing.
    (50 + floor(s.input_roll * s.input_roll * 8000))::int                        as input_tokens,
    (10 + floor(s.output_roll * s.output_roll * 3000))::int                      as output_tokens,
    (120 + floor(s.latency_roll * s.latency_roll * s.latency_roll * 24000))::int as response_time_ms
  from series s
  join catalogue c on c.pick = s.catalogue_pick
  join teams t     on t.pick = s.team_pick
)
insert into logs (
  id,
  organization_id,
  model,
  provider,
  status,
  input_tokens,
  output_tokens,
  input_cost,
  output_cost,
  response_time_ms,
  request_object_reference,
  response_object_reference,
  tags,
  created_at,
  updated_at
)
select
  id,
  $1::uuid,
  model,
  provider,
  status,
  case when status = 'incomplete' then null else input_tokens end,
  case when status = 'complete'   then output_tokens end,
  case when status = 'incomplete' then 0 else round(input_tokens * cost_input, 12) end,
  case when status = 'complete'   then round(output_tokens * cost_output, 12) else 0 end,
  case when status = 'incomplete' then null else response_time_ms end,

  -- Borrowed keys when there are any, otherwise per-row synthetic ones that
  -- mirror objectKey() in logs.services.ts and point at objects nobody wrote.
  --
  -- The status gating stays either way: an 'incomplete' row died before there
  -- was anything to store and a 'failed' one never produced a response, so
  -- giving those a payload would make has_request/has_response uniformly true
  -- and hide the states the row component renders differently.
  case when status = 'incomplete' then null
       else coalesce($10::text, 'logs/' || $1::text || '/' || id::text || '/request.json.zst') end,
  case when status = 'complete'
       then coalesce($11::text, 'logs/' || $1::text || '/' || id::text || '/response.json.zst') end,

  jsonb_build_object($8::text, $9::text, 'env', env, 'team', team),
  created_at,
  created_at
from shaped
`;

/**
 * Seeds `count` logs for one organization.
 *
 * Rows are spread evenly across the trailing `windowDays`, ending at roughly
 * now, so the newest seeded log is current and analytics date filters have
 * something to bite on. Seeding twice does not extend the window - it doubles
 * the density inside it.
 *
 * What this deliberately does NOT do is write payload objects. Two PUTs per row
 * would turn an eight-second seed into an hour and would be stressing MinIO
 * rather than the database - a different axis, worth its own harness.
 *
 * So rows either advertise synthetic keys that resolve to nothing, or - with
 * `payloads` - share one real pair borrowed from an existing log. The first is
 * enough for every measurement here, since list and aggregate queries never
 * reach object storage. The second is what makes the result worth opening in
 * the dashboard. See findBorrowablePayloads.
 */
export async function seedLogs(admin: SQL, options: SeedOptions): Promise<void> {
  const { organizationId, count, windowDays, chunkSize } = options;

  const windowMilliseconds = windowDays * 24 * 60 * 60 * 1000;

  // Fractional on purpose. Forcing a whole millisecond would silently stretch
  // the window when count exceeds it - a million rows would span 17 minutes
  // instead of the month that was asked for, and every date-range scenario
  // would degenerate into "all of them".
  const stepMilliseconds = windowMilliseconds / count;
  const windowStart = new Date(Date.now() - windowMilliseconds);

  const catalogue = JSON.stringify(weightedCatalogue());
  const teams = JSON.stringify(TEAMS);

  for (let first = 0; first < count; first += chunkSize) {
    const last = Math.min(first + chunkSize, count) - 1;

    await admin.unsafe(INSERT, [
      organizationId,
      windowStart.toISOString(),
      stepMilliseconds,
      catalogue,
      teams,
      first,
      last,
      SEED_TAG_KEY,
      SEED_TAG_VALUE,
      options.payloads?.request ?? null,
      options.payloads?.response ?? null,
    ]);

    options.onProgress?.(last + 1, count);
  }

  // Not optional, and not tidiness.
  //
  // A bulk insert leaves pg_statistic describing the table as it was before,
  // and the planner believes it until autovacuum gets round to the table -
  // which is minutes, long after a run has finished and been written down. In
  // that window it costs plans against the wrong row counts and picks
  // accordingly: the tag filter measured at 3.3ms on a sequential scan over
  // twenty thousand rows, and 0.18ms on the GIN index it switched to once the
  // statistics caught up. Same query, same data, an 18x difference that has
  // nothing to do with the size being tested.
  //
  // So the seed is not finished until the planner knows what was seeded.
  await admin`analyze logs`;
}

/**
 * Finds a real log whose payloads seeded rows can point at.
 *
 * Restricted to rows the harness did NOT write, because a seeded row's keys are
 * exactly the ones that resolve to nothing - borrowing from one would produce
 * five hundred thousand rows all confidently naming the same absent object.
 * Only a log the gateway actually wrote has objects behind it.
 *
 * The newest such log, so a database whose early objects have aged out under a
 * lifecycle rule still yields a live one.
 *
 * Note that this does not verify the objects are really in the bucket - the row
 * is the only evidence available from here, and a row naming a deleted object
 * is indistinguishable from a row naming a present one without asking S3. The
 * caller finds out on the first read.
 */
export async function findBorrowablePayloads(
  admin: SQL,
  organizationId: string,
): Promise<BorrowedPayloads | undefined> {
  const marker = JSON.stringify({ [SEED_TAG_KEY]: SEED_TAG_VALUE });

  const [row] = await admin`
    select request_object_reference as request, response_object_reference as response
    from logs
    where organization_id = ${organizationId}
      and request_object_reference is not null
      and response_object_reference is not null
      and not (coalesce(tags, '{}'::jsonb) @> (${marker}::text)::jsonb)
    order by id desc
    limit 1
  `;

  return row ? { request: row.request, response: row.response } : undefined;
}

/** How many logs the organization holds, seeded or otherwise. */
export async function countLogs(admin: SQL, organizationId: string): Promise<number> {
  const [row] = await admin`select count(*)::int as total from logs where organization_id = ${organizationId}`;

  return row?.total ?? 0;
}

/**
 * Removes seeded logs, and only seeded logs.
 *
 * Scoped by the seed tag rather than by organization, so pointing the harness
 * at a real tenant and cleaning up afterwards cannot take that tenant's actual
 * logs with it.
 */
export async function deleteSeededLogs(admin: SQL, organizationId: string): Promise<number> {
  const marker = JSON.stringify({ [SEED_TAG_KEY]: SEED_TAG_VALUE });

  // ::text before ::jsonb - see the note above INSERT. Without it the
  // comparison is against a jsonb string, which matches nothing, and the
  // cleanup silently reports zero rows removed.
  const rows = await admin`
    delete from logs
    where organization_id = ${organizationId} and tags @> (${marker}::text)::jsonb
    returning 1
  `;

  return rows.length;
}

/**
 * Finds an organization by id or slug, creating it if the slug is unknown.
 *
 * Creating on demand is what keeps the default safe: with no --organization the
 * harness seeds into an organization that exists only for this, so a run cannot
 * put twenty thousand synthetic rows in front of whoever opens the dashboard
 * next. Pointing it at a real tenant is possible, and has to be asked for.
 */
export async function resolveOrganization(admin: SQL, reference: string): Promise<{ id: string; slug: string }> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference);

  const [existing] = isUuid
    ? await admin`select id, slug from organizations where id = ${reference}`
    : await admin`select id, slug from organizations where slug = ${reference}`;

  if (existing) {
    return { id: existing.id, slug: existing.slug };
  }

  if (isUuid) {
    throw new Error(`No organization with id ${reference}. Pass a slug to have one created.`);
  }

  const [created] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values (${`stress-${reference}`}, 'stress-harness', ${reference}, ${reference})
    returning id, slug
  `;

  if (!created) {
    throw new Error(`Failed to create organization "${reference}"`);
  }

  return { id: created.id, slug: created.slug };
}
