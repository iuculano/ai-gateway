import { expect, test } from 'bun:test';
import { requestTurns, responseTurns } from '../../src/lib/data/conversation';

// Payloads come back from object storage untyped, and some were written by
// older gateways.
const NOT_CONVERSATIONS = [null, 'plain text', 42, {}, { messages: 'hello' }, { messages: [null, { role: 'robot' }] }];

test('a request is read back as the turns that were sent, in order', () => {
  const payload = {
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is the weather in Paris?' },
    ],
  };

  expect(requestTurns(payload)).toEqual([
    { role: 'system', text: 'Be brief.' },
    { role: 'user', text: 'What is the weather in Paris?' },
  ]);
});

test('a turn that only calls a tool names the call instead of rendering blank', () => {
  const payload = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-a', function: { name: 'get_weather', arguments: '{ "city": "Paris" }' } }],
        },
      },
    ],
  };

  expect(responseTurns(payload)).toEqual([
    { role: 'assistant', text: '', note: 'Called get_weather({"city":"Paris"})' },
  ]);
});

test('images are counted, because their content cannot be shown as text', () => {
  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in these?' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
        ],
      },
    ],
  };

  expect(requestTurns(payload)).toEqual([{ role: 'user', text: 'What is in these?', note: '2 images attached' }]);
});

test('a refusal is shown as one', () => {
  const payload = { choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }] };

  expect(responseTurns(payload)).toEqual([{ role: 'assistant', text: '', note: 'Refused: I cannot help with that.' }]);
});

test('a turn with nothing to say is left out', () => {
  const payload = {
    messages: [
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Hello' },
    ],
  };

  expect(requestTurns(payload)).toEqual([{ role: 'user', text: 'Hello' }]);
});

test('a payload that is not a conversation renders as nothing instead of throwing', () => {
  for (const payload of NOT_CONVERSATIONS) {
    expect(requestTurns(payload)).toEqual([]);
    expect(responseTurns(payload)).toEqual([]);
  }
});
