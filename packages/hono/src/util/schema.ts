import type { z } from '@hono/zod-openapi';

export interface Schema {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  headers?: z.ZodType;
  response?: z.ZodType | Record<number, z.ZodType>;
}

/**
 * Creates a schema object while keeping the specific inferred type.
 *
 * This is a runtime no-op, but it prevents TypeScript from widening the value
 * to the generic Schema type, wwhich would turn response into something like
 * z.ZodType | Record<number, z.ZodType> | undefined.
 */
export function createSchema<const TSchema extends Schema>(schema: TSchema): TSchema {
  return schema;
}
