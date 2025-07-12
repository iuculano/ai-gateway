import { type Context, type ValidationTargets,} from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from '@hono/zod-openapi';
import { STATUS_CODES } from 'node:http';
import logger from '../clients/pino';


// Just mimic what the OpenAPIHono does expects for the defaultHook
type ErrorHook = {
  target: keyof ValidationTargets;
} & ({
  success: false;
  error: z.ZodError;
} | {
  success: true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
});

/**
 * Hook to handle Zod validation errors after validation in OpenAPIHono routes.
 *
 * For whatever reason, the OpenAPIHono doesn't throw an HTTPException
 * automatically when Zod validation fails, so we have to do it ourselves.
 *
 * This must be used as the defaultHook for the CHILD OpenAPIHono instances!
 * Assigning it to the top most OpenAPIHono instance will not work.
 *
 * https://github.com/honojs/middleware/tree/main/packages/zod-openapi#handling-validation-errors
 *
 * @param result
 * The result object from Zod validation, containing success status and
 * error/data.
 *
 * @throws {HTTPException}
 * If validation fails with a ZodError.
 */
export function zodExceptionHook(result: ErrorHook) {
  if (!result.success && result.error instanceof z.ZodError) {
    // If it's a ZodError, just pass it along as the cause
    throw new HTTPException(400, {
      message: result.error.message || 'Bad Request',
      cause: result.error,
    });
  }
}

/**
 * Middleware for handling errors.
 *
 * - Zod validation errors will be returned as a formatted response.
 * - For unhandled errors, a generic 500 Internal Server Error response is
 *   returned.
 *
 * @returns
 * An async middleware function.
 */
export function errorHandler() {
  return async (err: Error, c: Context)=> {
    const requestId = c.var?.requestId;
    const childLogger = logger.child({
      'id    ': requestId,
      'path  ': c.req.path,
      'method': c.req.method,
    });

    if (err instanceof HTTPException) {
      // Check if Zod has raised an error, return its details
      if (err.cause instanceof z.ZodError) {
        return c.json(
          {
            error: 'Validation failed',
            details: (err.cause as z.ZodError).errors, // Detailed Zod errors
          },
          err.status
        );
      }

      // We probably raised the HTTPException ourselves - return the
      // exception status code and log the error
      childLogger.error({
        'code  ': err.status,
        'status': STATUS_CODES[err.status],
         ...(err.cause ? { cause: err.cause } as object : {}), // gross
      }, err.message || 'HTTP Exception');

      return err.getResponse();
    }

    // Log other errors as internal server errors, something raised in an
    // unexpected way
    childLogger?.error({ err }, 'Unhandled exception');
    return c.json({ error: 'Internal Server Error' }, 500);
  };
}
