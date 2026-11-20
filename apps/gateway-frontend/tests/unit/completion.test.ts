import { expect, test } from 'bun:test';
import type { ChatCompletionChunk } from '../../src/lib/api/chat-completions';
import type { ChatCompletion } from '../../src/lib/api/types';
import {
  applyChunk,
  type CompletionAssembly,
  emptyAssembly,
  fromCompletion,
  toResponsePayload,
} from '../../src/lib/data/completion';
import { responseTurns } from '../../src/lib/data/conversation';

type Delta = ChatCompletionChunk['choices'][number]['delta'];

function chunk(delta: Delta, finish_reason: string | null = null): ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-5',
    choices: [{ index: 0, delta: delta, finish_reason: finish_reason }],
  } as ChatCompletionChunk;
}

function assemble(chunks: ChatCompletionChunk[]): CompletionAssembly {
  const assembly = emptyAssembly();

  for (const frame of chunks) {
    applyChunk(assembly, frame);
  }

  return assembly;
}

test('a stream is assembled into its text, finish reason and usage', () => {
  const usage = { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 };

  // The usage frame comes last and carries no choices at all.
  const usageFrame = { id: 'chatcmpl-1', model: 'gpt-5', choices: [], usage: usage } as unknown as ChatCompletionChunk;

  const assembly = assemble([chunk({ content: 'Hello' }), chunk({ content: ' there' }, 'stop'), usageFrame]);

  expect(assembly).toMatchObject({ content: 'Hello there', finishReason: 'stop', usage: usage });
});

test('two tool calls whose fragments interleave are put back together by position', () => {
  const frames = [
    chunk({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'get_weather', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call-b', function: { name: 'get_time', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '{"zone":"UTC"}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, 'tool_calls'),
  ];

  const assembly = assemble(frames as ChatCompletionChunk[]);

  expect(assembly.toolCalls).toEqual([
    { id: 'call-a', name: 'get_weather', arguments: '{"city":"Paris"}' },
    { id: 'call-b', name: 'get_time', arguments: '{"zone":"UTC"}' },
  ]);
});

test('a streamed tool call reads the same in the transcript as a stored one', () => {
  const streamed = assemble([
    chunk({
      tool_calls: [{ index: 0, id: 'call-a', function: { name: 'get_weather', arguments: '{"city": "Paris"}' } }],
    }),
  ] as ChatCompletionChunk[]);

  const turns = responseTurns(toResponsePayload(streamed));

  expect(turns).toEqual([{ role: 'assistant', text: '', note: 'Called get_weather({"city":"Paris"})' }]);
});

test('a whole completion with no choices is an empty answer rather than an error', () => {
  const completion = { id: 'chatcmpl-1', model: 'gpt-5', choices: [], usage: null } as unknown as ChatCompletion;

  const assembly = fromCompletion(completion);

  expect(assembly).toMatchObject({ content: '', toolCalls: [], finishReason: null });
});
