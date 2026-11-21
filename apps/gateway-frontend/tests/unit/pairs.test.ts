import { expect, test } from 'bun:test';
import { toPairs, toRecord } from '../../src/lib/data/pairs';

test('a map comes back the same after a trip through the editor', () => {
  const tags = { team: 'support', region: 'eu' };

  const pairs = toPairs(tags);

  expect(pairs).toEqual([
    { key: 'team', value: 'support' },
    { key: 'region', value: 'eu' },
  ]);
  expect(toRecord(pairs)).toEqual(tags);
});

test('a row with no key is dropped, and the rest are trimmed', () => {
  const record = toRecord([
    { key: ' region ', value: ' eu ' },
    { key: '   ', value: 'never typed a key' },
  ]);

  expect(record).toEqual({ region: 'eu' });
});

test('nothing left to send is undefined, which clears the field', () => {
  // An empty map would be stored as one, and an empty filter matches nothing.
  expect(toRecord([{ key: '', value: '' }])).toBeUndefined();
  expect(toPairs(null)).toEqual([]);
});
