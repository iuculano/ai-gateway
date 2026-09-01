import { expect, test } from 'bun:test';
import { z } from '@hono/zod-openapi';
import { bearerSecurity, createSchema, protectedRouteErrors, validatedProtectedRouteErrors } from '../../index';

test('createSchema preserves the exact object at runtime', () => {
  const schema = {
    query: z.object({ limit: z.number().int() }),
    response: { 200: z.object({ healthy: z.boolean() }) },
  };

  expect(createSchema(schema)).toBe(schema);
});

test('protected route helpers document authentication, quota, and validation responses', () => {
  expect(bearerSecurity).toEqual([{ bearerAuth: [] }]);
  expect(Object.keys(protectedRouteErrors).map(Number)).toEqual([401, 403, 429, 500]);
  expect(Object.keys(validatedProtectedRouteErrors).map(Number)).toEqual([400, 401, 403, 429, 500]);
  expect(protectedRouteErrors[403].headers).toHaveProperty('WWW-Authenticate');
  expect(protectedRouteErrors[429].headers).toHaveProperty('Retry-After');
  expect(protectedRouteErrors[429].headers).toHaveProperty('RateLimit');
  expect(protectedRouteErrors[429].headers).toHaveProperty('RateLimit-Policy');
});
