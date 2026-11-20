import type { HttpError } from '@repo/core';
import { errorHandler } from '@repo/hono';
import { APICallError } from 'ai';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** OpenAI's error body.
 *
 * The OpenAI SDK expects errors in this shape.
 */
export interface OpenAIError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

type UpstreamDetails = Partial<Record<'type' | 'param' | 'code', string | null>>;

/**
 * Helper to build an OpenAI-compatible error object.
 *
 * @param status
 * The HTTP status the caller gets.
 *
 * @param message
 * What went wrong, already safe to show.
 *
 * @param cause
 * The exception's cause, which carries the provider's error when there was one.
 *
 * @param param
 * The request field at fault, if one is known.
 */
export function toOpenAIError(
  status: number,
  message: string,
  cause: unknown,
  param: string | null = null,
): OpenAIError {
  const upstream = APICallError.isInstance(cause)
    ? (cause.data as { error?: UpstreamDetails } | undefined)?.error
    : undefined;

  return {
    error: {
      message,
      type: upstream?.type ?? (status >= 500 ? 'server_error' : 'invalid_request_error'),
      param: upstream?.param ?? param,
      code: upstream?.code ?? null,
    },
  };
}

/**
 * Helper middlewware to create an OpenAI-compatible error handler for the
 * gateway.
 *
 * Transforms a gateway error into an OpenAI-compatible response.
 */
export function openAIErrorHandler() {
  const handle = errorHandler();

  return async (error: Error, c: Context) => {
    const response = handle(error, c);

    const { error: details } = (await response.json()) as HttpError;
    const field = details.details?.[0]?.field;
    const param = typeof field === 'string' ? field.replace(/^json\./, '') : null;

    // OpenAI's shape has no list of issues, so the first one's reason goes in
    // the message.
    const issue = details.details?.[0]?.issue;

    const body = toOpenAIError(
      response.status,
      typeof issue === 'string' ? `${details.message} ${issue}` : details.message,
      error instanceof HTTPException ? error.cause : undefined,
      param,
    );

    // No longer correct - size wwill differ, can't reuse this.
    const headers = new Headers(response.headers);
    headers.delete('content-length');

    return new Response(JSON.stringify(body), { status: response.status, headers });
  };
}
