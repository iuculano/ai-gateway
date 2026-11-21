interface LatestOptions {
  /**
   * Shown when a rejection carries nothing readable of its own.
   */
  failureMessage?: string;

  /**
   * For something that is only fetched when it is asked for, which is not
   * loading until then.
   */
  idle?: boolean;
}

/**
 * The newest answer to a question that is asked again and again, such as what
 * a set of filters shows. A request that a newer one has overtaken is dropped
 * when it lands, so that a slow early answer cannot replace a later one.
 */
export class Latest<T> {
  /**
   * The newest answer to have arrived, which stays in place while the next one
   * loads.
   */
  value: T | null = $state(null);

  /**
   * True from the start unless the answer is fetched on demand, because a
   * question that has not been answered yet is still being asked.
   */
  loading = $state(true);

  /**
   * Why the newest request failed, or null when it did not.
   */
  error: string | null = $state(null);

  readonly #failureMessage: string;
  #request = 0;

  constructor(options: LatestOptions = {}) {
    this.#failureMessage = options.failureMessage ?? 'The request failed.';
    this.loading = !options.idle;
  }

  /**
   * Asks again, and keeps the answer unless a newer request was made first.
   */
  async load(fetchValue: () => Promise<T>): Promise<void> {
    const request = ++this.#request;

    this.loading = true;
    this.error = null;

    try {
      const value = await fetchValue();

      if (request === this.#request) {
        this.value = value;
      }
    } catch (error) {
      if (request === this.#request) {
        this.error = error instanceof Error ? error.message : this.#failureMessage;
      }
    } finally {
      if (request === this.#request) {
        this.loading = false;
      }
    }
  }
}
