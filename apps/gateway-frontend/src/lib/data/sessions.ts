import type { SessionDistributionResponse, SessionPositionsResponse, SessionsResponse } from '#lib/api/analytics.ts';
import { fmt } from '#lib/data/format.ts';
import { percentileAt } from '#lib/data/percentiles.ts';

export type Session = SessionsResponse['top'][number];
export type Position = SessionPositionsResponse['positions'][number];
export type SessionSort = 'spend' | 'requests' | 'length';

/**
 * One bar of the cost-by-position chart, for a position or a run of them.
 */
export interface PositionBar {
  first: number;
  last: number;

  /**
   * Average cost of a request at these positions.
   */
  cost: number;

  /**
   * Average input tokens, which is the history sent.
   */
  input: number;

  /**
   * Sessions that got as far as the first of these positions.
   */
  sessions: number;
}

/**
 * Groups positions into at most `maxBars` bars, so that bars stay wide enough
 * to read and hover.
 *
 * @param rows
 * One row per position, in order.
 *
 * @param maxBars
 * The most bars the chart has room for.
 */
export function binPositions(rows: Position[], maxBars: number): PositionBar[] {
  const size = Math.max(1, Math.ceil(rows.length / maxBars));
  const bars: PositionBar[] = [];

  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    const first = chunk[0] as Position;
    const last = chunk.at(-1) as Position;
    let cost = 0;
    let input = 0;
    let requests = 0;

    // Sums are added up before dividing, so a bar is the true average of the
    // requests it covers and not an average of averages.
    for (const row of chunk) {
      cost += row.cost_total;
      input += row.input_tokens;
      requests += row.requests;
    }

    bars.push({
      first: first.position,
      last: last.position,
      cost: requests > 0 ? cost / requests : 0,
      input: requests > 0 ? input / requests : 0,
      sessions: first.sessions,
    });
  }

  return bars;
}

/**
 * How many times the first request's average cost a later request comes to,
 * or null when either is missing.
 */
export function costGrowth(positions: Position[], position: number): number | null {
  const first = positions[0];
  const later = positions.find((row) => row.position === position);

  if (!first || !later || first.cost_total <= 0) {
    return null;
  }

  return later.cost_total / later.requests / (first.cost_total / first.requests);
}

/**
 * A session's figure for the order its list is in.
 */
export function sessionMeasure(session: Session, sort: SessionSort): number {
  if (sort === 'spend') {
    return session.cost_total;
  }

  if (sort === 'requests') {
    return session.requests;
  }

  return session.seconds;
}

/**
 * Who took part in a session, as the one user or how many shared it.
 */
export function participants(session: Session): string {
  if (session.user_id) {
    return session.user_id;
  }

  return session.users > 1 ? `${fmt(session.users)} users` : '—';
}

/**
 * The typical and the heavy session across everyone, or null when there are
 * no sessions to place.
 */
export function sessionSpread(
  distribution: SessionDistributionResponse | null,
): { medianCost: number; p95Cost: number; medianRequests: number; medianSeconds: number } | null {
  if (!distribution?.sessions) {
    return null;
  }

  return {
    medianCost: percentileAt(distribution.cost_percentiles, 50),
    p95Cost: percentileAt(distribution.cost_percentiles, 95),
    medianRequests: Math.round(percentileAt(distribution.request_percentiles, 50)),
    medianSeconds: percentileAt(distribution.seconds_percentiles, 50),
  };
}

/**
 * How many sessions cost a dollar or more, and what they spent between them.
 */
export function heavySessions(bands: SessionDistributionResponse['cost_bands']): { sessions: number; spend: number } {
  let sessions = 0;
  let spend = 0;

  for (const band of bands) {
    if (band.min >= 1) {
      sessions += band.sessions;
      spend += band.cost_total;
    }
  }

  return { sessions: sessions, spend: spend };
}

function bandEdge(dollars: number): string {
  return dollars < 1 ? `${Math.round(dollars * 100)}¢` : `$${dollars}`;
}

/**
 * A spend band's range in cents under a dollar and dollars above, such as
 * '1¢ – 10¢' or '$10+'.
 */
export function costBand(min: number, max: number | null): string {
  if (max === null) {
    return `${bandEdge(min)}+`;
  }

  return min === 0 ? `< ${bandEdge(max)}` : `${bandEdge(min)} – ${bandEdge(max)}`;
}

/**
 * A request-count band's range, such as '2 – 5' or '21+'.
 */
export function requestBand(min: number, max: number | null): string {
  if (max === null) {
    return `${min}+`;
  }

  return min === max ? `${min}` : `${min} – ${max}`;
}
