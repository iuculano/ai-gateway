import { config } from 'zod';

/**
 * Turns off zod's memoizer, we don't need this as it stands and it's at the
 * top of the profiler under severe load.
 *
 * AI SDK spends a significant amount of CPU time here.
 */
config({
  memoizer: {
    attach() {},
    guard() {},
    alloc: (_inst, _payload, empty) => empty,
  },
});
