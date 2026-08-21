import { describe, expect, test } from 'bun:test';
import { createCacheKey } from '../../src/create-cache-key';

describe('createCacheKey', () => {
  test('returns a deterministic prefixed SHA-256 key', () => {
    const first = createCacheKey('analytics:', { organization_id: 'org-1', model: 'gpt-test', active: true });
    const second = createCacheKey('analytics:', { organization_id: 'org-1', model: 'gpt-test', active: true });

    expect(first).toBe(second);
    expect(first).toMatch(/^analytics:[0-9a-f]{64}$/);
  });

  test('changes when the prefix, value, type, or array order changes', () => {
    expect(createCacheKey('one:', 1)).not.toBe(createCacheKey('two:', 1));
    expect(createCacheKey('key:', 1)).not.toBe(createCacheKey('key:', '1'));
    expect(createCacheKey('key:', ['a', 'b'])).not.toBe(createCacheKey('key:', ['b', 'a']));
  });

  test('supports every JSON primitive and Date serialization', () => {
    for (const value of [null, true, false, 0, '', 'value', new Date('2026-01-02T03:04:05.000Z')]) {
      expect(createCacheKey('key:', value)).toMatch(/^key:[0-9a-f]{64}$/);
    }
  });

  test('rejects top-level and nested values JSON would silently discard or rewrite', () => {
    const invalid = [
      undefined,
      () => undefined,
      Symbol('value'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { value: undefined },
      { value: () => undefined },
      { value: Symbol('value') },
      { value: Number.NEGATIVE_INFINITY },
      [undefined],
    ];

    for (const value of invalid) {
      expect(() => createCacheKey('key:', value)).toThrow('Cache key data is not JSON-serializable');
    }
  });

  test('normalizes BigInt and circular-reference failures to the package error', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() => createCacheKey('key:', 1n)).toThrow('Cache key data is not JSON-serializable');
    expect(() => createCacheKey('key:', circular)).toThrow('Cache key data is not JSON-serializable');
  });
});
