import { expect, test } from 'bun:test';
import { assertNever } from '../../index';

test('assertNever reports the unhandled runtime value', () => {
  expect(() => assertNever('UNHANDLED_CODE' as never)).toThrow('Unhandled service failure code: "UNHANDLED_CODE"');
  expect(() => assertNever({ code: 'NESTED' } as never)).toThrow('Unhandled service failure code: {"code":"NESTED"}');
});
