import { expect, test } from 'bun:test';
import type { ChatCompletionMessage } from '../../src/lib/api/chat-completions';
import {
  blankDrafts,
  type DraftMessage,
  draftsFrom,
  fieldsOutsideForm,
  formJson,
  parseJsonObject,
  type Sampling,
  samplingError,
  toMessages,
} from '../../src/lib/data/playground-request';

const UNSET: Sampling = { temperature: undefined, topP: undefined, maxTokens: undefined };

// toMessages

test('blank messages are not sent, and the rest keep their role and lose stray whitespace', () => {
  const drafts: DraftMessage[] = [
    { role: 'system', content: '   ' },
    { role: 'developer', content: 'Answer in French.' },
    { role: 'user', content: '  Hello\n' },
    { role: 'assistant', content: 'Bonjour' },
  ];

  expect(toMessages(drafts)).toEqual([
    { role: 'developer', content: 'Answer in French.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Bonjour' },
  ]);
});

// samplingError

test('parameters left unset, or at the ends of their range, can be sent', () => {
  expect(samplingError(UNSET)).toBeNull();
  expect(samplingError({ temperature: 0, topP: 0, maxTokens: 1 })).toBeNull();
  expect(samplingError({ temperature: 2, topP: 1, maxTokens: 4_096 })).toBeNull();
});

test('a parameter outside its range is named before anything is sent', () => {
  expect(samplingError({ ...UNSET, temperature: 2.1 })).toContain('Temperature');
  expect(samplingError({ ...UNSET, temperature: Number.NaN })).toContain('Temperature');
  expect(samplingError({ ...UNSET, topP: 1.5 })).toContain('Top P');

  // A token limit has to be a whole number of at least one.
  expect(samplingError({ ...UNSET, maxTokens: 0 })).toContain('Max completion tokens');
  expect(samplingError({ ...UNSET, maxTokens: 12.5 })).toContain('Max completion tokens');
});

// draftsFrom

test('a stored request is edited as text, leaving out the messages the composer cannot write', () => {
  const messages = [
    { role: 'system', content: 'Be brief.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in ' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        { type: 'text', text: 'this picture?' },
      ],
    },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ] as ChatCompletionMessage[];

  expect(draftsFrom(messages)).toEqual([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is in this picture?' },
    { role: 'assistant', content: '' },
  ]);
});

test('a request with nothing the composer can show opens the blank composer', () => {
  const messages = [{ role: 'tool', tool_call_id: 'call_1', content: 'done' }] as ChatCompletionMessage[];

  expect(draftsFrom(messages)).toEqual(blankDrafts());
});

// JSON mode

test('the JSON view holds only what the form has set', () => {
  const drafts: DraftMessage[] = [
    { role: 'system', content: '' },
    { role: 'user', content: 'Hello' },
  ];

  const body = JSON.parse(formJson(drafts, { ...UNSET, temperature: 0 }));

  expect(body).toEqual({ messages: [{ role: 'user', content: 'Hello' }], temperature: 0 });
});

test('only a JSON object is a request body', () => {
  expect(parseJsonObject('{"messages":[]}')).toEqual({ messages: [] });

  expect(parseJsonObject('[1, 2]')).toBeNull();
  expect(parseJsonObject('null')).toBeNull();
  expect(parseJsonObject('{"messages":')).toBeNull();
});

test('returning to the form names the fields it cannot keep', () => {
  const body = { model: 'openai/gpt-5', messages: [], top_p: 1, seed: 7, stop: ['\n'] };

  expect(fieldsOutsideForm(body)).toEqual(['seed', 'stop']);
});

test('a form with other fields of its own keeps those and names the rest', () => {
  const body = { model: 'openai/gpt-5', input: 'A message', questions: [], messages: [] };

  expect(fieldsOutsideForm(body, ['input', 'questions'])).toEqual(['messages']);
});
