import { expect, test } from 'bun:test';
import { tokenBand, type User, userMeasure } from '../../src/lib/data/users';

test('a user is measured by whatever their list is ordered by', () => {
  const user = { user_id: 'ada', cost_total: 1.5, tokens: 4200, requests: 12 } as User;

  expect(userMeasure(user, 'spend')).toBe(1.5);
  expect(userMeasure(user, 'tokens')).toBe(4200);
  expect(userMeasure(user, 'requests')).toBe(12);
});

test('a token band reads in thousands above a thousand and is open at either end', () => {
  expect(tokenBand(0, 500)).toBe('< 500');
  expect(tokenBand(0, 1000)).toBe('< 1K');

  expect(tokenBand(1000, 4000)).toBe('1K – 4K');
  expect(tokenBand(64_000, null)).toBe('64K+');
});
