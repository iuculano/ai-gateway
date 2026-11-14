import { expect, test } from 'bun:test';
import { readChunks } from '../../src/lib/api/chat-completions';

function body(frames: string[]) {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join('')).body as ReadableStream<Uint8Array>;
}

const chunk = JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] });

test('an error frame mid-stream surfaces the provider message, after the chunks before it', async () => {
  const seen: string[] = [];
  const read = async () => {
    for await (const { raw } of readChunks(
      body([chunk, JSON.stringify({ error: { message: 'Provider error: overloaded' } })]),
    )) {
      seen.push(raw);
    }
  };

  expect(read()).rejects.toThrow('Provider error: overloaded');
  await read().catch(() => {});
  expect(seen[0]).toBe(chunk);
});

test('a stream that ends with [DONE] reads to the end', async () => {
  const seen: string[] = [];
  for await (const { raw } of readChunks(body([chunk, '[DONE]']))) {
    seen.push(raw);
  }
  expect(seen).toEqual([chunk]);
});
