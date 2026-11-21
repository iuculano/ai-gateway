import { expect, test } from 'bun:test';
import { Latest } from '../../src/lib/state/latest.svelte';

test('an answer that arrives after a newer one is dropped', async () => {
  const latest = new Latest<string>();
  const early = Promise.withResolvers<string>();
  const late = Promise.withResolvers<string>();

  const first = latest.load(() => early.promise);
  const second = latest.load(() => late.promise);
  late.resolve('newer');
  await second;
  early.resolve('older');
  await first;

  expect(latest.value).toBe('newer');
});

test('a request that was overtaken and then failed is not reported', async () => {
  const latest = new Latest<string>();
  const early = Promise.withResolvers<string>();

  const first = latest.load(() => early.promise);
  await latest.load(() => Promise.resolve('newer'));
  early.reject(new Error('Offline'));
  await first;

  expect(latest.error).toBeNull();
  expect(latest.value).toBe('newer');
});

test('it is loading from the start, and until the newest request settles', async () => {
  const latest = new Latest<string>();
  const early = Promise.withResolvers<string>();
  const late = Promise.withResolvers<string>();
  const before = latest.loading;

  const first = latest.load(() => early.promise);
  const second = latest.load(() => late.promise);
  early.resolve('older');
  await first;
  const between = latest.loading;
  late.resolve('newer');
  await second;

  expect([before, between, latest.loading]).toEqual([true, true, false]);
});

test('the last answer stays up while the next loads, and through a failure', async () => {
  const latest = new Latest<string>({ failureMessage: 'Could not load.' });
  await latest.load(() => Promise.resolve('first'));
  const next = Promise.withResolvers<string>();

  const pending = latest.load(() => next.promise);
  const during = latest.value;
  next.reject('not an error object');
  await pending;

  expect(during).toBe('first');
  expect(latest.value).toBe('first');
  expect(latest.error).toBe('Could not load.');
});

test('something fetched on demand is not loading until it is asked for', async () => {
  const latest = new Latest<string>({ idle: true });
  const answer = Promise.withResolvers<string>();
  const before = latest.loading;

  const pending = latest.load(() => answer.promise);
  const during = latest.loading;
  answer.resolve('there');
  await pending;

  expect([before, during, latest.loading]).toEqual([false, true, false]);
});
