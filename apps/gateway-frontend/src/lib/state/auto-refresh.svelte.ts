import { toast } from 'svelte-sonner';

/**
 * How often a tailing table re-reads its newest page.
 *
 * Every list here is a cursor-paginated database read, so this is cheap - but
 * it is still one request per table per tab per tick, which is why it stays
 * opt-in rather than always on.
 */
export const AUTO_REFRESH_INTERVAL_MS = 10_000;

/**
 * The tailing switch behind every table's auto-refresh.
 *
 * Generalised from the logs page, which had the only implementation and had
 * already worked out the three things that matter:
 *
 *  - a tick must be SILENT. Flipping the table's `loading` flag every few
 *    seconds swaps the rows the reader is looking at for a spinner.
 *  - a tick must not clobber pagination. Refreshing re-reads the HEAD of the
 *    list, so it only runs while the table is actually showing the head - see
 *    `active` on schedule().
 *  - a tick that fails must stop. Keeping the stale rows, saying so once, and
 *    switching itself off beats retrying into the same error every interval and
 *    stacking toasts until the reader leaves.
 */
export class AutoRefresh {
  /** Off by default. Nothing polls unless the reader asks for it. */
  enabled = $state(false);

  /** True while a tick is in flight, for the indicator beside the switch. */
  refreshing = $state(false);

  readonly intervalMs: number;

  constructor(intervalMs: number = AUTO_REFRESH_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /**
   * Starts and stops the timer.
   *
   * Call this as the whole body of an `$effect`, returning what it returns. The
   * effect is what makes the teardown run on both halves of the switch: turning
   * it off tears the interval down, and so does leaving the page. A bare
   * setInterval would keep firing after navigation.
   *
   * @param active
   * Whether the table is currently showing the head of its list. A table paged
   * away from the head has nothing to tail - new rows arrive at the head - and
   * re-reading it would discard the pages the reader walked to.
   *
   * @param tick
   * Re-reads the head. It should NOT set the table's loading or error state,
   * and it SHOULD throw on failure, which is what switches this off.
   */
  schedule(active: boolean, tick: () => Promise<void>): (() => void) | undefined {
    if (!this.enabled || !active) {
      return;
    }

    const timer = setInterval(() => void this.#run(tick), this.intervalMs);
    return () => clearInterval(timer);
  }

  async #run(tick: () => Promise<void>): Promise<void> {
    // A slow tick must not have the next one start on top of it. The interval
    // does not wait, so this is the only thing that stops them piling up.
    if (this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      await tick();
    } catch (error) {
      this.enabled = false;
      toast.error(`Auto-refresh stopped: ${error instanceof Error ? error.message : 'the request failed.'}`);
    } finally {
      this.refreshing = false;
    }
  }
}
