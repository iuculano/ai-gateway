import { z } from '@hono/zod-openapi';

export const httpError = z
  .object({
    error: z
      .object({
        code: z.number(),
        status: z.string(),
        message: z.string(),
        details: z.array(z.record(z.string(), z.unknown())).optional(),
        // Echoed so clients can quote it in bug reports; joins against the
        // request_id in logs and audit entries.
        request_id: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type HttpError = z.infer<typeof httpError>;
