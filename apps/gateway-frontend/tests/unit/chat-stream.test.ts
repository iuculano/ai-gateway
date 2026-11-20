import { expect, test } from 'bun:test';
import { readChunks } from '../../src/lib/api/chat-completions';

const CHUNK = JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] });

/**
 * A response body carrying the given frames, the way the gateway writes them.
 */
function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  const text = frames.map((frame) => `data: ${frame}\n\n`).join('');
  const response = new Response(text);

  return response.body as ReadableStream<Uint8Array>;
}

/**
 * Reads a stream to its end, keeping what arrived before any failure.
 */
async function readAll(frames: string[]): Promise<{ chunks: string[]; failure: unknown }> {
  const chunks: string[] = [];

  try {
    for await (const { raw } of readChunks(streamOf(frames))) {
      chunks.push(raw);
    }
  } catch (error) {
    return { chunks: chunks, failure: error };
  }

  return { chunks: chunks, failure: undefined };
}

test('a stream that ends with [DONE] yields every chunk', async () => {
  const { chunks, failure } = await readAll([CHUNK, CHUNK, '[DONE]']);

  expect(failure).toBeUndefined();
  expect(chunks).toEqual([CHUNK, CHUNK]);
});

test('an error frame surfaces the provider message after the chunks before it', async () => {
  const errorFrame = JSON.stringify({ error: { message: 'Provider error: overloaded' } });

  const { chunks, failure } = await readAll([CHUNK, errorFrame]);

  expect(failure).toEqual(new Error('Provider error: overloaded'));
  expect(chunks).toEqual([CHUNK]);
});

test('a stream that stops without [DONE] is reported as unfinished', async () => {
  // A dropped connection must not read as the model choosing to stop there.
  const { chunks, failure } = await readAll([CHUNK]);

  expect(failure).toEqual(new Error('The stream ended before the completion finished.'));
  expect(chunks).toEqual([CHUNK]);
});
