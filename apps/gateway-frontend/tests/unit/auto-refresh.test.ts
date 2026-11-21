import { beforeEach, expect, mock, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';

const toast = { error: mock((_message: string): void => {}) };

// Must precede the import below, because the notices are a browser component.
mock.module('svelte-sonner', () => ({ toast: toast }));

const { AutoRefresh } = await import('../../src/lib/state/auto-refresh.svelte');

// Ticks every few milliseconds, so that a test can watch several go by.
const INTERVAL_MS = 5;

beforeEach(() => {
  toast.error.mockClear();
});

test('nothing is scheduled while the switch is off, or the table is away from its head', () => {
  const auto = new AutoRefresh(INTERVAL_MS);
  const tick = mock(() => Promise.resolve());

  const whileOff = auto.schedule(true, tick);
  auto.enabled = true;
  const awayFromHead = auto.schedule(false, tick);

  expect(whileOff).toBeUndefined();
  expect(awayFromHead).toBeUndefined();
});

test('the head is read again on every tick until the timer is stopped', async () => {
  const auto = new AutoRefresh(INTERVAL_MS);
  const tick = mock(() => Promise.resolve());
  auto.enabled = true;

  const stop = auto.schedule(true, tick);
  await sleep(INTERVAL_MS * 6);
  stop?.();
  const ticks = tick.mock.calls.length;
  await sleep(INTERVAL_MS * 4);

  expect(ticks).toBeGreaterThan(1);
  expect(tick.mock.calls.length).toBe(ticks);
});

test('a slow tick is not started again on top of itself', async () => {
  const auto = new AutoRefresh(INTERVAL_MS);
  const tick = mock(() => sleep(INTERVAL_MS * 20));
  auto.enabled = true;

  const stop = auto.schedule(true, tick);
  await sleep(INTERVAL_MS * 10);
  stop?.();

  expect(tick).toHaveBeenCalledTimes(1);
});

test('a tick that fails switches the tailing off and says why', async () => {
  const auto = new AutoRefresh(INTERVAL_MS);
  auto.enabled = true;

  const stop = auto.schedule(true, () => Promise.reject(new Error('Offline')));
  await sleep(INTERVAL_MS * 3);
  stop?.();

  expect(auto.enabled).toBe(false);
  expect(toast.error.mock.calls[0]?.[0]).toBe('Auto-refresh stopped: Offline');
});
