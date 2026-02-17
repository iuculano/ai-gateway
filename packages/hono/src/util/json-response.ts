import type { ResponseConfig, ZodMediaTypeObject } from '@asteasolutions/zod-to-openapi';

interface JsonResponseOptions {
  description?: string;
  schema: ZodMediaTypeObject['schema'];
  headers?: ResponseConfig['headers'];
}

export function jsonContent(schema: ZodMediaTypeObject['schema']) {
  return {
    "application/json": {
      schema,
    },
  } as const;
}

export function jsonResponse(options: JsonResponseOptions): ResponseConfig {
  const { description, schema, headers } = options;

  return {
    description: description ?? '',
    ...(headers ? { headers } : {}),
    content: jsonContent(schema),
  } as const;
}
