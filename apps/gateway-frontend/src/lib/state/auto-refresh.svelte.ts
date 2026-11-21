import { toast } from 'svelte-sonner';

// How often a tailing table reads its newest page again. It is one request for
// each table in each tab on every tick, which is why tailing is something the
// reader switches on.
export const AUTO_REFRESH_INTERVAL_MS = 10_000;

/**
 * The tailing switch behind every table's auto-refresh.
 */
export class AutoRefresh {
  /**
   * Off to begin with. Nothing polls unless the reader asks for it.
   */
  enabled = $state(false);

  /**
   * True while a tick is out, for the indicator beside the switch.
   */
  refreshing = $state(false);

  readonly intervalMs: number;

  constructor(intervalMs: number = AUTO_REFRESH_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /**
   * Starts the timer, and returns what stops it.
   *
   * It is meant to be the whole body of an effect, which then returns what this
   * returns. The effect is what stops the timer on both halves of the switch,
   * when it is turned off and when the page is left. A bare interval would keep
   * firing after navigation.
   *
   * @param active
   * Whether the table is showing the head of its list. New rows arrive at the
   * head, so a table paged away from it has nothing to tail, and reading the
   * head again would discard the pages the reader walked to.
   *
   * @param tick
   * Reads the head again. It must not set the table's loading or error state,
   * which would swap the rows on show for a spinner every few seconds, and it
   * must throw when it fails.
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
      // A tick that fails stops the tailing. Keeping the rows, saying so once
      // and switching off beats retrying into the same error on every tick and
      // stacking up notices until the reader leaves.
      this.enabled = false;
      toast.error(`Auto-refresh stopped: ${error instanceof Error ? error.message : 'the request failed.'}`);
    } finally {
      this.refreshing = false;
    }
  }
}
