import type { Log } from '#lib/api/types.ts';

// Reading what a log stored. Payloads come back from object storage as
// unknown, and were as often as not written by an older gateway, so nothing
// here trusts their shape.

/**
 * A stored payload as a record, or an empty one when it is anything else.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Why the model stopped, from a stored chat response, or null when it does
 * not say.
 */
export function finishReason(response: unknown): string | null {
  const choices = asRecord(response).choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const reason = asRecord(choices[0]).finish_reason;

  return typeof reason === 'string' ? reason : null;
}

/**
 * What a request cost, or null when that is not known, which must not read as
 * free.
 */
export function logCost(log: Pick<Log, 'input_cost' | 'output_cost'>): number | null {
  if (log.input_cost == null || log.output_cost == null) {
    return null;
  }

  // Postgres hands a numeric back as a string, and adding two of those would
  // join them end to end.
  return Number(log.input_cost) + Number(log.output_cost);
}

/**
 * The texts an embedding request asked for.
 */
export function embeddingInputs(request: unknown): string[] {
  const input = asRecord(request).input;

  if (typeof input === 'string') {
    return [input];
  }

  return Array.isArray(input) ? input.filter((value): value is string => typeof value === 'string') : [];
}

/**
 * The embeddings in a stored response.
 */
export function embeddingsOf(response: unknown): { embedding?: unknown }[] {
  const data = asRecord(response).data;

  return Array.isArray(data) ? data : [];
}

/**
 * How many numbers each embedding in a stored response holds, or null when
 * that cannot be told.
 */
export function embeddingDimensions(response: unknown): number | null {
  const first = embeddingsOf(response)[0]?.embedding;

  if (Array.isArray(first)) {
    return first.length;
  }

  // The other encoding is base64 of little-endian 32-bit floats, which is four
  // bytes to a number.
  return typeof first === 'string' ? Math.floor(atob(first).length / 4) : null;
}
