import { expect, test } from 'bun:test';
import { readChunks } from '../../src/lib/api/chat-completions';

function body(frames: string[]) {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join('')).body as ReadableStream<Uint8Array>;
}

const chunk = JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] });

test('an error frame mid-stream surfaces the provider message, after the chunks before it', async () => {
  const frames = [chunk, JSON.stringify({ error: { message: 'Provider error: overloaded' } })];
  const seen: string[] = [];
  let failure: unknown;

  try {
    for await (const { raw } of readChunks(body(frames))) {
      seen.push(raw);
    }
  } catch (error) {
    failure = error;
  }

  expect(failure).toEqual(new Error('Provider error: overloaded'));
  expect(seen).toEqual([chunk]);
});

test('a stream that ends with [DONE] reads to the end', async () => {
  const seen: string[] = [];
  for await (const { raw } of readChunks(body([chunk, '[DONE]']))) {
    seen.push(raw);
  }
  expect(seen).toEqual([chunk]);
});
