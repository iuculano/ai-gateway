import type { ChatCompletionMessage, ChatCompletionRole } from '#lib/api/chat-completions.ts';

// The roles the composer offers, which is short of the request schema's full
// set on purpose. A tool message must carry a tool_call_id matching an
// assistant tool call earlier in the conversation, and a composer that let one
// be written without its partner would produce requests the provider rejects.
export const COMPOSER_ROLES = ['system', 'developer', 'user', 'assistant'] as const;

// The body fields the form can show. Anything else only survives in JSON.
const FORM_FIELDS = ['messages', 'temperature', 'top_p', 'max_completion_tokens'];

export type ComposerRole = Extract<ChatCompletionRole, (typeof COMPOSER_ROLES)[number]>;

export interface DraftMessage {
  role: ComposerRole;
  content: string;
}

/**
 * The sampling parameters the form offers. One left undefined is not sent, so
 * the provider's own default applies.
 */
export interface Sampling {
  temperature: number | undefined;
  topP: number | undefined;
  maxTokens: number | undefined;
}

export function emptyDraft(role: ComposerRole = 'user'): DraftMessage {
  return { role: role, content: '' };
}

/**
 * What the composer opens with, which is the shape almost every first request
 * has.
 */
export function blankDrafts(): DraftMessage[] {
  return [emptyDraft('system'), emptyDraft('user')];
}

function toMessage(draft: DraftMessage): ChatCompletionMessage {
  const content = draft.content.trim();

  // Built per role and not spread from one object. The role is a union of four
  // literals, and an object typed that way does not narrow to any one member of
  // the union it has to satisfy.
  switch (draft.role) {
    case 'system':
      return { role: 'system', content: content };
    case 'developer':
      return { role: 'developer', content: content };
    case 'assistant':
      return { role: 'assistant', content: content };
    default:
      return { role: 'user', content: content };
  }
}

/**
 * The drafts as request messages, without the ones left empty.
 */
export function toMessages(drafts: DraftMessage[]): ChatCompletionMessage[] {
  // A blank system row is the composer's own default, and forwarding it would
  // put an empty instruction in front of every conversation started here.
  return drafts.filter((draft) => draft.content.trim().length > 0).map(toMessage);
}

/**
 * What is wrong with the sampling parameters, as a sentence for the reader, or
 * null when they can be sent.
 */
export function samplingError(sampling: Sampling): string | null {
  const { temperature, topP, maxTokens } = sampling;

  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return 'Temperature must be between 0 and 2.';
  }

  if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
    return 'Top P must be between 0 and 1.';
  }

  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    return 'Max completion tokens must be a positive safe integer.';
  }

  return null;
}

function isComposerMessage(
  message: ChatCompletionMessage,
): message is Extract<ChatCompletionMessage, { role: ComposerRole }> {
  return (COMPOSER_ROLES as readonly string[]).includes(message.role);
}

/**
 * A stored request's messages as drafts the composer can edit, or the blank
 * composer when it has none it can show.
 */
export function draftsFrom(messages: ChatCompletionMessage[]): DraftMessage[] {
  const drafts: DraftMessage[] = [];

  for (const message of messages) {
    if (!isComposerMessage(message)) {
      continue;
    }

    // Content can arrive as parts. The composer edits text, so the text parts
    // are joined and the rest are left out.
    const content =
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');

    drafts.push({ role: message.role, content: content });
  }

  return drafts.length > 0 ? drafts : blankDrafts();
}

/**
 * The form as the JSON the request editor shows.
 */
export function formJson(drafts: DraftMessage[], sampling: Sampling): string {
  // JSON.stringify drops the parameters left undefined.
  const body = {
    messages: toMessages(drafts),
    temperature: sampling.temperature,
    top_p: sampling.topP,
    max_completion_tokens: sampling.maxTokens,
  };

  return JSON.stringify(body, null, 2);
}

/**
 * Text as a JSON object, or null when it is anything else.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return null;
}

/**
 * The fields of a request body that the form has no control for, and so would
 * lose.
 *
 * @param formFields
 * The fields the form does have, which are the chat form's unless given.
 */
export function fieldsOutsideForm(body: Record<string, unknown>, formFields: string[] = FORM_FIELDS): string[] {
  // The model has its own control beside the form.
  return Object.keys(body).filter((key) => key !== 'model' && !formFields.includes(key));
}
