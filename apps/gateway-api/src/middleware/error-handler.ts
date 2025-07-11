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

// Basically, this just acts as a hook that runs after the Zod validation and
// throws a typical HTTPException if something went wrong.
//
// For whatever reason, the OpenAPIHono doesn't throw an HTTPException
// automatically when Zod validation fails, so we have to do it ourselves.
//
// This must be used as the defaultHook for the child OpenAPIHono instances.
// You cannot assign it to the topmost instance, it'll never be called.
// https://github.com/honojs/middleware/tree/main/packages/zod-openapi#handling-validation-errors
export function zodExceptionHook(result: ErrorHook) {
  if (!result.success && result.error instanceof z.ZodError) {
    // If it's a ZodError, just pass it along as the cause
    throw new HTTPException(400, {
      message: result.error.message || 'Bad Request',
      cause: result.error,
    });
  }
}

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
