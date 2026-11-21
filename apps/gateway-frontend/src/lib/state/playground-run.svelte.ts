import {
  type ChatCompletionRequest,
  createChatCompletion,
  type GatewayHeaders,
  streamChatCompletion,
} from '#lib/api/chat-completions.ts';
import {
  applyChunk,
  type CompletionAssembly,
  emptyAssembly,
  fromCompletion,
  producesOutput,
} from '#lib/data/completion.ts';

/**
 * One model's half of a playground request.
 *
 * Comparing two models is the same operation as running one, done twice, so
 * single and compare modes both run through this. The request body is handed
 * over on each send and not held, because in compare mode one body is shared by
 * every run and only the model differs.
 */
export class PlaygroundRun {
  /**
   * The model this run sends to, which replaces whatever the shared body names.
   */
  model = $state('');

  /**
   * The provider credential this run spends. Each run has its own, because
   * comparing models from two providers needs two keys. It is held in memory
   * and nowhere else, since anything stored in the browser would outlive the
   * page and be readable by any script on this origin.
   */
  apiKey = $state('');

  assembly = $state<CompletionAssembly>(emptyAssembly());

  /**
   * The response as it arrived, which is a completion object for a whole
   * response and the `data:` payloads, one to a line, for a streamed one. It is
   * a string and not a list of frames, because adding to a string is cheap and
   * joining a thousand frames again on every token is not.
   */
  wire = $state('');

  running = $state(false);
  error = $state<string | null>(null);
  traceId = $state<string | null>(null);
  elapsedMs = $state<number | null>(null);
  firstTokenMs = $state<number | null>(null);

  #controller: AbortController | null = null;

  constructor(model = '') {
    this.model = model;
  }

  /**
   * Clears the last response, keeping the model.
   */
  reset(): void {
    this.assembly = emptyAssembly();
    this.wire = '';
    this.error = null;
    this.traceId = null;
    this.elapsedMs = null;
    this.firstTokenMs = null;
  }

  stop(): void {
    this.#controller?.abort();
  }

  /**
   * Sends one request and records what came back. It never throws, because in
   * compare mode several runs are out at once and one provider refusing a key
   * must not take the others down with it.
   *
   * @param headers
   * The gateway's `ai-*` controls. `ai-api-key` is replaced with this run's
   * own.
   *
   * @param body
   * The shared request. `model` is replaced with this run's own.
   *
   * @param stream
   * Whether to read the response as server-sent events.
   */
  async send(headers: GatewayHeaders, body: ChatCompletionRequest, stream: boolean): Promise<void> {
    if (this.running) {
      return;
    }

    const controller = new AbortController();
    const request: ChatCompletionRequest = { ...body, model: this.model.trim() };
    const sent: GatewayHeaders = { ...headers, 'ai-api-key': this.apiKey.trim() };
    const startedAt = performance.now();

    this.#controller = controller;
    this.running = true;
    this.reset();

    try {
      if (stream) {
        await this.#readStream(sent, request, controller.signal, startedAt);
      } else {
        const result = await createChatCompletion(sent, request, controller.signal);

        this.traceId = result.traceId;
        this.assembly = fromCompletion(result.completion);
        this.wire = JSON.stringify(result.completion, null, 2);
      }

      this.elapsedMs = performance.now() - startedAt;
    } catch (error) {
      // Stopping is not failing. The fetch rejects the same way for both, so
      // the signal is what tells a deliberate stop from a real error, and
      // whatever streamed in before the stop stays on show.
      if (controller.signal.aborted) {
        this.elapsedMs = performance.now() - startedAt;
      } else {
        this.error = error instanceof Error ? error.message : 'The request failed.';
      }
    } finally {
      this.running = false;
      this.#controller = null;
    }
  }

  async #readStream(
    headers: GatewayHeaders,
    request: ChatCompletionRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<void> {
    const opened = await streamChatCompletion(headers, request, signal);

    this.traceId = opened.traceId;

    for await (const { chunk, raw } of opened.chunks) {
      // Timed on the first chunk that carries output, and not on the first
      // chunk of all, which the reader cannot see anything of yet.
      if (this.firstTokenMs === null && producesOutput(chunk)) {
        this.firstTokenMs = performance.now() - startedAt;
      }

      applyChunk(this.assembly, chunk);
      this.wire += `${raw}\n`;
    }
  }
}
