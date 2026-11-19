import { expect, test } from 'bun:test';
import { abandonedCallSignal } from '../../src/api/chat-completions/chat-completions.services';

test('a call is only cut off some time after its caller has left', async () => {
  const caller = new AbortController();
  const signal = abandonedCallSignal(caller.signal, 30);

  // Still waiting: never aborted, however long the provider takes.
  await Bun.sleep(60);
  expect(signal.aborted).toBe(false);

  caller.abort();
  expect(signal.aborted).toBe(false);
  await Bun.sleep(60);
  expect(signal.aborted).toBe(true);
});

test('a call with no caller signal is never cut off', async () => {
  const signal = abandonedCallSignal(undefined, 10);
  await Bun.sleep(30);
  expect(signal.aborted).toBe(false);
});
