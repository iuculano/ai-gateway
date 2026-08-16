import { describe, expect, test } from 'bun:test';
import { diffFields } from '../src/diff';

interface Row extends Record<string, unknown> {
  name: string;
  enabled: boolean;
  nullable: string | null;
  count: number;
  config: { modes: string[] };
  updated_at: Date;
}

const existing: Row = {
  name: 'original',
  enabled: true,
  nullable: 'present',
  count: 4,
  config: { modes: ['fast', 'safe'] },
  updated_at: new Date('2026-01-02T03:04:05.000Z'),
};

describe('diffFields', () => {
  test('returns every supplied writable field but audits only changed values', () => {
    const result = diffFields(
      existing,
      {
        name: 'original',
        enabled: false,
        nullable: null,
        config: { modes: ['fast', 'safe'] },
      },
      ['name', 'enabled', 'nullable', 'config'],
    );

    expect(result.updates).toEqual({
      name: 'original',
      enabled: false,
      nullable: null,
      config: { modes: ['fast', 'safe'] },
    });
    expect(result.difference).toEqual({
      enabled: { old: true, new: false },
      nullable: { old: 'present', new: null },
    });
  });

  test('treats undefined as absent while preserving other falsy values', () => {
    const result = diffFields(existing, { name: '', count: 0, enabled: false, nullable: undefined }, [
      'name',
      'count',
      'enabled',
      'nullable',
    ]);

    expect(result.updates).toEqual({ name: '', count: 0, enabled: false });
    expect(result.difference).toEqual({
      name: { old: 'original', new: '' },
      count: { old: 4, new: 0 },
      enabled: { old: true, new: false },
    });
  });

  test('ignores patch fields outside the explicit allowlist', () => {
    const result = diffFields(existing, { name: 'changed', count: 99 }, ['name']);

    expect(result.updates).toEqual({ name: 'changed' });
    expect(result.difference).toEqual({ name: { old: 'original', new: 'changed' } });
  });

  test('compares nested objects, arrays, and dates by value', () => {
    const equal = diffFields(
      existing,
      {
        config: { modes: ['fast', 'safe'] },
        updated_at: new Date('2026-01-02T03:04:05.000Z'),
      },
      ['config', 'updated_at'],
    );
    const changed = diffFields(existing, { config: { modes: ['safe'] } }, ['config']);

    expect(equal.difference).toEqual({});
    expect(changed.difference).toEqual({
      config: { old: { modes: ['fast', 'safe'] }, new: { modes: ['safe'] } },
    });
  });

  test('returns empty objects for an empty or entirely absent patch', () => {
    expect(diffFields(existing, {}, ['name', 'enabled'])).toEqual({ updates: {}, difference: {} });
    expect(diffFields(existing, { name: undefined }, ['name'])).toEqual({ updates: {}, difference: {} });
  });
});
