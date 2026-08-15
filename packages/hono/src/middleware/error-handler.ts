import { STATUS_CODES } from 'node:http';
import { z } from '@hono/zod-openapi';
import { type HttpError, logger } from '@repo/core';
import type { Context, ValidationTargets } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** What zodExceptionHook() attaches as the HTTPException cause. */
interface ValidationCause {
  target: keyof ValidationTargets;
  error: z.ZodError;
}

function isValidationCause(cause: unknown): cause is ValidationCause {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'error' in cause &&
    (cause as { error: unknown }).error instanceof z.ZodError
  );
}

// Just mimic what the OpenAPIHono does expects for the defaultHook
type ErrorHook = {
  target: keyof ValidationTargets;
} & (
  | {
      success: false;
      error: z.ZodError;
    }
  | {
      success: true;
      data: unknown;
    }
);

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
  // Propagate the error if it is a ZodError, we've failed validation somewhere
  if (!result.success && result.error instanceof z.ZodError) {
    throw new HTTPException(400, {
      message: 'Request validation failed.',
      // Carry the target too, so the response can say WHERE the bad field
      // lives (body vs query vs param), not just its name.
      cause: {
        target: result.target,
        error: result.error,
      } satisfies ValidationCause,
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
 * Every response echoes the request id so clients can quote it; log records
 * go through the request-scoped logger so they carry the correlation ids.
 *
 * @returns
 * An error handler function.
 */
export function errorHandler() {
  return (err: Error, c: Context) => {
    const requestId: string | undefined = c.var.requestId;
    const log = c.var.logger ?? logger;

    // If it's an HTTPException, we probably threw it intentionally.
    if (err instanceof HTTPException) {
      const formattedError: HttpError = {
        error: {
          code: err.status,
          status: STATUS_CODES[err.status] ?? 'Unknown',
          message: err.message || 'An error occurred',
        },
      };

      const cause = err.cause;
      if (isValidationCause(cause)) {
        formattedError.error.details = cause.error.issues.map((issue) => ({
          field: [cause.target, ...issue.path.map(String)].join('.'),
          issue: issue.message,
        }));
      }

      // 4xx is the client's mistake and normal traffic; only 5xx should be
      // able to page anyone.
      const level = err.status >= 500 ? 'error' : 'warn';
      log[level]({ err, 'http.response.status_code': err.status }, err.message || 'HTTP exception');

      const response = c.json(formattedError, err.status);

      // An HTTPException can carry a prebuilt Response - hono's own middleware
      // and our adapters use it to attach headers (WWW-Authenticate,
      // Retry-After, RateLimit-*). 
      //
      // Pass these headers along to the final response.
      if (err.res) {
        err.res.headers.forEach((value, key) => {
          if (key === 'content-type' || key === 'content-length') {
            return;
          }

          response.headers.set(key, value);
        });
      }

      return response;
    }

    // Something raised in an unexpected way - it's not a ZodError or an
    // HTTPException.
    //
    // Basically, we probably didn't intentionally throw it.
    log.error({ err, 'http.response.status_code': 500 }, 'Unhandled exception');
    return c.json(
      {
        error: {
          code: 500,
          status: STATUS_CODES[500],
          message: 'An unexpected error occurred',
        },
      },
      500,
    );
  };
}
