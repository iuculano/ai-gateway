import type { ChatCompletionChunk } from '$lib/api/chat-completions';
import type { ChatCompletion, ChatCompletionFinishReason, ChatCompletionUsage } from '$lib/api/types';

/**
 * A completion being rebuilt from whatever the gateway sent.
 *
 * The streamed and the whole path both end up here so that the transcript, the
 * stats strip and the finish reason have ONE shape to read. Without it the page
 * would carry two response models that have to be kept saying the same thing.
 */

/** One tool call, reassembled from the deltas that carried it. */
interface AssembledToolCall {
  id: string;

  name: string;

  /** A JSON *string*, and one that arrives a fragment at a time. */
  arguments: string;
}

export interface CompletionAssembly {
  /** The provider's id for the completion. Empty until the first frame lands. */
  id: string;

  /** As the provider named it, which is not always as the request spelled it. */
  model: string;

  content: string;
  refusal: string;
  toolCalls: AssembledToolCall[];

  /** Null until the model stops, which on a stream is the second-to-last frame. */
  finishReason: ChatCompletionFinishReason | null;

  /**
   * Null until the usage frame arrives, and null forever if the provider never
   * sends one. Distinguishing that from zero matters - a run that reports no
   * usage has not spent nothing.
   */
  usage: ChatCompletionUsage | null;
}

export function emptyAssembly(): CompletionAssembly {
  return {
    id: '',
    model: '',
    content: '',
    refusal: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
}

/**
 * Folds one streamed frame into the assembly, in place.
 *
 * @param assembly
 * The assembly so far. Mutated.
 *
 * @param chunk
 * The frame just received.
 */
export function applyChunk(assembly: CompletionAssembly, chunk: ChatCompletionChunk): void {
  assembly.id = chunk.id;
  assembly.model = chunk.model;

  // Read outside the choices loop on purpose: the gateway's trailing usage
  // frame carries an EMPTY choices array, so anything nested in that loop would
  // never see it.
  if (chunk.usage) {
    assembly.usage = chunk.usage;
  }

  for (const choice of chunk.choices) {
    if (choice.finish_reason) {
      assembly.finishReason = choice.finish_reason;
    }

    const delta = choice.delta;

    if (delta.content) {
      assembly.content += delta.content;
    }

    if (delta.refusal) {
      assembly.refusal += delta.refusal;
    }

    for (const call of delta.tool_calls ?? []) {
      // Deltas address a call by POSITION rather than by id, and a provider
      // emitting two calls interleaves their fragments, so the array is grown
      // to fit the index rather than pushed onto.
      while (assembly.toolCalls.length <= call.index) {
        assembly.toolCalls.push({ id: '', name: '', arguments: '' });
      }

      const target = assembly.toolCalls[call.index];

      if (call.id) {
        target.id = call.id;
      }

      // Concatenated, not assigned. Names usually arrive whole, but nothing in
      // the protocol says they have to.
      if (call.function?.name) {
        target.name += call.function.name;
      }

      if (call.function?.arguments) {
        target.arguments += call.function.arguments;
      }
    }
  }
}

/**
 * The same assembly, from a completion that arrived in one piece.
 *
 * @param completion
 * The gateway's response to a non-streamed request.
 *
 * @returns
 * The assembly the rest of the page reads.
 */
export function fromCompletion(completion: ChatCompletion): CompletionAssembly {
  // `n` is pinned to 1 by the request schema, so there is exactly one choice -
  // but an indexed read is still guarded, because a response that somehow
  // carries none should render as an empty answer rather than throw.
  const choice = completion.choices[0];

  return {
    id: completion.id,
    model: completion.model,
    content: choice?.message.content ?? '',
    refusal: choice?.message.refusal ?? '',
    toolCalls: (choice?.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: completion.usage,
  };
}

/**
 * The assembly in the shape requestTurns() / responseTurns() read.
 *
 * Reusing the logs page's converter rather than writing a second one is what
 * keeps a streamed answer, a whole one and a stored one rendering identically -
 * including the notes for tool calls and refusals, which are easy to get subtly
 * different when the logic exists twice.
 *
 * @param assembly
 * The assembly to render.
 *
 * @returns
 * A completion-shaped payload. Partial on purpose: the converter reads
 * choices[].message and nothing else.
 */
export function toResponsePayload(assembly: CompletionAssembly) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: assembly.content,
          refusal: assembly.refusal.length > 0 ? assembly.refusal : null,
          tool_calls: assembly.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        },
      },
    ],
  };
}
