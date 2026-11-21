import { expect, test } from 'bun:test';
import type { Log } from '../../src/lib/api/types';
import { embeddingDimensions, embeddingInputs, finishReason, logCost } from '../../src/lib/data/log-payloads';

/**
 * A log's two costs as they arrive. The API type calls them numbers, but
 * Postgres sends a numeric as a string.
 */
function costs(input: string | null, output: string | null): Log {
  return { input_cost: input, output_cost: output } as unknown as Log;
}

test('the finish reason is read off the first choice, and is missing from anything else', () => {
  expect(finishReason({ choices: [{ finish_reason: 'length' }] })).toBe('length');

  expect(finishReason({ choices: [] })).toBeNull();
  expect(finishReason({ error: { message: 'Upstream failed' } })).toBeNull();
  expect(finishReason(null)).toBeNull();
});

test('a cost that arrives as two strings is added and not joined', () => {
  const cost = logCost(costs('0.002', '0.004'));

  expect(cost).toBeCloseTo(0.006, 10);
});

test('a cost with either half unknown is unknown, and not free', () => {
  expect(logCost(costs('0.002', null))).toBeNull();
  expect(logCost(costs(null, null))).toBeNull();
});

test('an embedding request holds one text or a list of them', () => {
  expect(embeddingInputs({ input: 'one text' })).toEqual(['one text']);
  expect(embeddingInputs({ input: ['first', [1, 2, 3], 'second'] })).toEqual(['first', 'second']);
  expect(embeddingInputs({})).toEqual([]);
});

test('an embedding has a dimension per number, or per four bytes when it is base64', () => {
  const twoFloats = btoa(String.fromCharCode(0, 0, 128, 63, 0, 0, 0, 64));

  expect(embeddingDimensions({ data: [{ embedding: [0.1, 0.2, 0.3] }] })).toBe(3);
  expect(embeddingDimensions({ data: [{ embedding: twoFloats }] })).toBe(2);
  expect(embeddingDimensions({ data: [] })).toBeNull();
});
