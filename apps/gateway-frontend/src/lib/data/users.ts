import type { UsersResponse } from '#lib/api/analytics.ts';

export type User = UsersResponse['users'][number];
export type UserSort = 'spend' | 'tokens' | 'requests';

/**
 * A user's figure for the order their list is in.
 */
export function userMeasure(user: User, sort: UserSort): number {
  if (sort === 'spend') {
    return user.cost_total;
  }

  return sort === 'tokens' ? user.tokens : user.requests;
}

function tokenAmount(tokens: number): string {
  return tokens >= 1000 ? `${tokens / 1000}K` : `${tokens}`;
}

/**
 * A token band's range in thousands above a thousand, such as '< 1K',
 * '1K – 4K' or '64K+'.
 */
export function tokenBand(min: number, max: number | null): string {
  if (max === null) {
    return `${tokenAmount(min)}+`;
  }

  return min === 0 ? `< ${tokenAmount(max)}` : `${tokenAmount(min)} – ${tokenAmount(max)}`;
}
