import { describe, expect, test } from 'bun:test';
import { parseTags } from '../../src/parse-tags';

describe('parseTags', () => {
  test('returns undefined when no filter was supplied', () => {
    expect(parseTags(undefined)).toBeUndefined();
    expect(parseTags('')).toBeUndefined();
  });

  test('parses comma-separated key/value pairs', () => {
    expect(parseTags('team:blue,environment:production')).toEqual({
      team: 'blue',
      environment: 'production',
    });
  });

  test('preserves colons inside tag values', () => {
    expect(parseTags('endpoint:https://example.test:8443,clock:12:30')).toEqual({
      endpoint: 'https://example.test:8443',
      clock: '12:30',
    });
  });

  test('skips malformed pairs and lets the last duplicate win', () => {
    expect(parseTags('missing-value:,missing-key,also-missing,team:red,team:blue,:empty-key')).toEqual({
      team: 'blue',
    });
  });

  test('returns an empty filter when a supplied string contains no valid pairs', () => {
    expect(parseTags('invalid,also-invalid')).toEqual({});
  });
});
