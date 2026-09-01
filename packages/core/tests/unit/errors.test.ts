import { describe, expect, test } from 'bun:test';
import { httpError } from '../../index';

describe('httpError', () => {
  test('accepts the minimal public error shape', () => {
    expect(
      httpError.parse({
        error: { code: 404, status: 'Not Found', message: 'Missing' },
      }),
    ).toEqual({
      error: { code: 404, status: 'Not Found', message: 'Missing' },
    });
  });

  test('rejects missing, mistyped, or unexpected fields', () => {
    expect(httpError.safeParse({ error: { status: 'Bad Request', message: 'Missing code' } }).success).toBe(false);
    expect(httpError.safeParse({ error: { code: '400', status: 'Bad Request', message: 'Wrong code' } }).success).toBe(
      false,
    );
    expect(
      httpError.safeParse({
        error: { code: 400, status: 'Bad Request', message: 'Extra', secret: 'do not expose' },
      }).success,
    ).toBe(false);
    expect(
      httpError.safeParse({
        error: { code: 400, status: 'Bad Request', message: 'Extra root' },
        debug: true,
      }).success,
    ).toBe(false);
  });
});
