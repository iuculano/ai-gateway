import { z } from '@hono/zod-openapi';


// Standardized shape of HTTP error responses.
export const httpError = z.object({
  error: z.object({
    code: z.number(),
    status: z.string(),
    message: z.string(),
    details: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
}).strict();

export type HttpError = z.infer<typeof httpError>;
