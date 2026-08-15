import type { LogPayload } from '$lib/api/types';

/**
 * Turns a stored log payload back into the conversation it represents.
 *
 * The panels show the raw JSON by default, which is the right thing when the
 * question is "what exactly went over the wire". It is the wrong thing when the
 * question is "what did the user ask and what did the model say" - the answer to
 * that is four or five lines buried in a body that is mostly parameters.
 *
 * Everything here is deliberately defensive. These payloads come back from
 * object storage as `unknown`, they were written by an older version of the
 * gateway as often as not, and a details panel that throws is worse than one
 * that renders half a conversation.
 */

export type TurnRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface Turn {
  role: TurnRole;

  /** Flattened text content. Empty when the turn carried none - see `note`. */
  text: string;

  /**
   * What the text alone cannot show: attached images, tool calls, a refusal.
   *
   * Without this a pure tool-call turn renders as a blank bubble, which reads
   * as "the model said nothing" rather than "the model called get_weather".
   */
  note?: string;
}

const ROLES: TurnRole[] = ['system', 'developer', 'user', 'assistant', 'tool'];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function isRole(value: unknown): value is TurnRole {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

/**
 * Flattens OpenAI's `string | Part[]` content down to text.
 *
 * Image parts carry no text, so they are counted instead and reported by the
 * caller as a note - dropping them silently would make a message with one line
 * of text and three screenshots look like a bare sentence.
 */
function flatten(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') {
    return { text: content, images: 0 };
  }

  if (!Array.isArray(content)) {
    return { text: '', images: 0 };
  }

  const text: string[] = [];
  let images = 0;

  for (const part of content) {
    const record = asRecord(part);

    if (record.type === 'text' && typeof record.text === 'string') {
      text.push(record.text);
    } else if (record.type === 'image_url') {
      images++;
    }
  }

  return { text: text.join(''), images: images };
}

/**
 * Renders tool calls the way a reader wants them: name and arguments, not the
 * call id, which is only meaningful to the protocol.
 */
function describeToolCalls(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const described = value.map((call) => {
    const fn = asRecord(asRecord(call).function);
    const name = typeof fn.name === 'string' ? fn.name : 'unknown';

    // Arguments arrive as a JSON *string*. Re-parsing and re-printing collapses
    // the provider's whitespace so a long call stays on one line; anything that
    // will not parse is shown as sent rather than hidden.
    let args = typeof fn.arguments === 'string' ? fn.arguments : '';
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {
      // Keep the raw string.
    }

    return `${name}(${args})`;
  });

  return `Called ${described.join(', ')}`;
}

function noteFor(images: number, toolCalls: unknown, refusal: unknown): string | undefined {
  const parts: string[] = [];

  if (images > 0) {
    parts.push(`${images} image${images === 1 ? '' : 's'} attached`);
  }

  const calls = describeToolCalls(toolCalls);
  if (calls) {
    parts.push(calls);
  }

  if (typeof refusal === 'string' && refusal.length > 0) {
    parts.push(`Refused: ${refusal}`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function toTurn(message: unknown): Turn | null {
  const record = asRecord(message);
  if (!isRole(record.role)) {
    return null;
  }

  const { text, images } = flatten(record.content);
  const note = noteFor(images, record.tool_calls, record.refusal);

  // A turn with neither text nor anything to say about it carries no
  // information, and an empty bubble is just noise in the transcript.
  if (!text && !note) {
    return null;
  }

  return { role: record.role, text: text, ...(note ? { note: note } : {}) };
}

/**
 * The conversation as it was SENT - every message in the request body, in order.
 *
 * System and tool turns are included rather than filtered: a reader asking why
 * the model answered the way it did is usually asking about the system prompt or
 * a tool result, and hiding those makes the transcript quietly misleading.
 */
export function requestTurns(payload: LogPayload): Turn[] {
  const messages = asRecord(payload).messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map(toTurn).filter((turn): turn is Turn => turn !== null);
}

/**
 * The conversation as it came BACK - the assistant message from each choice.
 *
 * `n` is pinned to 1 by the request schema, so this is one turn in practice, but
 * it maps over choices anyway rather than assuming the first is the only one.
 */
export function responseTurns(payload: LogPayload): Turn[] {
  const choices = asRecord(payload).choices;
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.map((choice) => toTurn(asRecord(choice).message)).filter((turn): turn is Turn => turn !== null);
}

/** The transcript as plain text, for the panel's copy button. */
export function turnsToText(turns: Turn[]): string {
  return turns
    .map((turn) => {
      const body = [turn.text, turn.note ? `[${turn.note}]` : ''].filter(Boolean).join('\n');
      return `${turn.role}:\n${body}`;
    })
    .join('\n\n');
}
