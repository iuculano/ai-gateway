import type { ChatCompletionRequest, GatewayHeaders } from '$lib/api/chat-completions';
import { createChatCompletion, streamChatCompletion } from '$lib/api/chat-completions';
import { applyChunk, type CompletionAssembly, emptyAssembly, fromCompletion } from '$lib/data/completion';

/**
 * One model's half of a playground request.
 *
 * Extracted from the page so single and compare modes cannot drift: comparing
 * two models is the same operation as running one, done twice, and the moment
 * the two have separate implementations they start reporting timings measured
 * differently or handling an abort differently.
 *
 * The body is supplied per send rather than held, because in compare mode one
 * body is shared by every run and only `model` differs. Substituting it here is
 * what makes "the same request, to several models" true by construction rather
 * than by the caller remembering to do it.
 */
export class PlaygroundRun {
  /** The model this run sends to. Overrides whatever the shared body carries. */
  model = $state('');

  /**
   * The upstream provider credential this run spends.
   *
   * Per run, not per page: comparing an OpenAI model against an Azure
   * deployment needs two different keys, and a single shared field could only
   * ever satisfy one of them.
   *
   * In memory and nowhere else. localStorage would survive a reload and leave a
   * provider key readable by anything that ever runs script on this origin.
   */
  apiKey = $state('');

  assembly = $state<CompletionAssembly>(emptyAssembly());

  /**
   * The response as it arrived on the wire: a completion object for a whole
   * response, or the `data:` payloads one per line for a streamed one.
   *
   * A string rather than an array of frames that gets joined. Appending to a
   * string is cheap; rebuilding a join of a thousand frames per token is not.
   */
  wire = $state('');

  running = $state(false);
  error = $state<string | null>(null);
  logId = $state<string | null>(null);
  elapsedMs = $state<number | null>(null);
  firstTokenMs = $state<number | null>(null);

  #controller: AbortController | null = null;

  constructor(model = '') {
    this.model = model;
  }

  /** Clears the last response, keeping the model. */
  reset(): void {
    this.assembly = emptyAssembly();
    this.wire = '';
    this.error = null;
    this.logId = null;
    this.elapsedMs = null;
    this.firstTokenMs = null;
  }

  stop(): void {
    this.#controller?.abort();
  }

  /**
   * Sends one request and records what came back.
   *
   * Never throws. In compare mode several of these are in flight at once and
   * one provider refusing a key must not take the others down with it - every
   * failure lands on the run it belongs to, which is also where a reader will
   * look for it.
   *
   * @param headers
   * The gateway's `ai-*` controls. `ai-api-key` is replaced with this run's own.
   *
   * @param body
   * The shared request. `model` is replaced with this run's own.
   *
   * @param stream
   * Whether to consume the response as server-sent events.
   */
  async send(headers: GatewayHeaders, body: ChatCompletionRequest, stream: boolean): Promise<void> {
    if (this.running) return;

    const controller = new AbortController();
    this.#controller = controller;
    const signal = controller.signal;

    this.running = true;
    this.reset();

    const request: ChatCompletionRequest = { ...body, model: this.model.trim() };
    const sent: GatewayHeaders = { ...headers, 'ai-api-key': this.apiKey.trim() };
    const startedAt = performance.now();

    try {
      if (stream) {
        const opened = await streamChatCompletion(sent, request, signal);
        this.logId = opened.logId;

        for await (const { chunk, raw } of opened.chunks) {
          // Measured on the first frame that carries OUTPUT, not on the first
          // frame full stop: providers open with a role-only delta, and timing
          // that would report a first token the reader cannot see yet.
          const produced = chunk.choices.some(
            (choice) => choice.delta.content || choice.delta.refusal || (choice.delta.tool_calls?.length ?? 0) > 0,
          );

          if (produced && this.firstTokenMs === null) {
            this.firstTokenMs = performance.now() - startedAt;
          }

          applyChunk(this.assembly, chunk);
          this.wire += `${raw}\n`;
        }
      } else {
        const result = await createChatCompletion(sent, request, signal);

        this.logId = result.logId;
        this.assembly = fromCompletion(result.completion);
        this.wire = JSON.stringify(result.completion, null, 2);
      }

      this.elapsedMs = performance.now() - startedAt;
    } catch (err) {
      // Stopping is not failing. The fetch rejects the same way either way, so
      // the signal is what separates a deliberate abort from a real error - and
      // whatever streamed in before the stop stays on screen.
      if (signal.aborted) {
        this.elapsedMs = performance.now() - startedAt;
      } else {
        this.error = err instanceof Error ? err.message : 'The request failed.';
      }
    } finally {
      this.running = false;
      this.#controller = null;
    }
  }
}
