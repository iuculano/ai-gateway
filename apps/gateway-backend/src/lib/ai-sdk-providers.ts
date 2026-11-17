import { STATUS_CODES } from 'node:http';
import { assertNever, BlockedUrlError } from '@repo/core';
import { getLogger } from '@repo/hono';
import {
  AISDKError,
  APICallError,
  DownloadError,
  InvalidArgumentError,
  InvalidMessageRoleError,
  InvalidPromptError,
  RetryError,
  UnsupportedFunctionalityError,
} from 'ai';
import { HTTPException } from 'hono/http-exception';
import type { ValidateAndOrderModelsFailure } from '../api/models/models.services';

// Failures from picking a catalog model for an AI SDK call.
type ModelUnsupportedProviderFailure = {
  code: 'MODEL_UNSUPPORTED_PROVIDER';
  model: string;
  provider: string;
};

export type ModelResolutionFailure = ValidateAndOrderModelsFailure | ModelUnsupportedProviderFailure;

// Failures from an upstream provider call made through the AI SDK.
type ProviderInvalidRequestFailure = {
  code: 'PROVIDER_INVALID_REQUEST';
  message: string;
  cause: unknown;
};

type ProviderRejectedRequestFailure = {
  code: 'PROVIDER_REJECTED_REQUEST';
  status: number;
  message: string;
  cause: unknown;
};

// The provider broke on its side or couldn't be reached.
type ProviderUnavailableFailure = {
  code: 'PROVIDER_UNAVAILABLE';
  message: string;
  cause: unknown;
};

type ProviderTimeoutFailure = {
  code: 'PROVIDER_TIMEOUT';
  cause: unknown;
};

// Something on the gateway's side threw during the call, most likely a bug.
type InternalFailure = {
  code: 'INTERNAL_ERROR';
  cause: unknown;
};

export type ProviderFailure =
  | ProviderInvalidRequestFailure
  | ProviderRejectedRequestFailure
  | ProviderUnavailableFailure
  | ProviderTimeoutFailure
  | InternalFailure;

// Network failures the AI SDK passes through unwrapped. It wraps refused and
// reset connections itself, but not failed DNS lookups.
const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * Whether a failed call should move on to the next model in routing order.
 *
 * @param failure
 * The failure object to evaluate.
 *
 * @returns
 * True if the call should fall back to the next model, false otherwise.
 */
export function shouldFallBack(failure: { code: string; status?: number }): boolean {
  switch (failure.code) {
    // This endpoint can't call that provider, but it may be able to call the next.
    case 'MODEL_UNSUPPORTED_PROVIDER':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return true;

    case 'PROVIDER_REJECTED_REQUEST':
      return failure.status === 429;

    default:
      return false;
  }
}

/**
 * Translates an error thrown by an AI SDK call into a typed provider failure.
 *
 * @param error
 * Whatever generateText, streamText, embedMany and friends threw.
 *
 * @returns
 * A typed provider failure representing the error.
 */
export function toProviderFailure(error: unknown): ProviderFailure {
  // RetryError hides the provider error that determines the response status.
  if (RetryError.isInstance(error)) {
    // An abort represents the caller's timeout rather than a provider response.
    if (error.reason === 'abort') {
      return { code: 'PROVIDER_TIMEOUT', cause: error };
    }

    return toProviderFailure(error.lastError);
  }

  // The caller's ai-base-url points somewhere the gateway won't call.
  if (error instanceof BlockedUrlError) {
    return { code: 'PROVIDER_INVALID_REQUEST', message: `ai-base-url: ${error.message}`, cause: error };
  }

  // An image URL in the request couldn't be fetched, or was too big.
  if (DownloadError.isInstance(error)) {
    return {
      code: 'PROVIDER_INVALID_REQUEST',
      message: `Could not fetch a URL in the request: ${error.message}`,
      cause: error,
    };
  }

  // These SDK errors identify request problems before an upstream response
  // exists.
  const isValidationError =
    InvalidPromptError.isInstance(error) ||
    InvalidMessageRoleError.isInstance(error) ||
    InvalidArgumentError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error);

  if (isValidationError) {
    return { code: 'PROVIDER_INVALID_REQUEST', message: error.message, cause: error };
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;

    if (status != null && status >= 400 && status < 500) {
      return { code: 'PROVIDER_REJECTED_REQUEST', status, message: error.message, cause: error };
    }

    return { code: 'PROVIDER_UNAVAILABLE', message: error.message, cause: error };
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { code: 'PROVIDER_TIMEOUT', cause: error };
  }

  // Any other SDK error is about what the provider sent back, such as a
  // malformed response or no content at all.
  if (AISDKError.isInstance(error)) {
    return { code: 'PROVIDER_UNAVAILABLE', message: error.message, cause: error };
  }

  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return { code: 'PROVIDER_UNAVAILABLE', message: `Cannot connect to the provider (${code})`, cause: error };
  }

  // Logged here because a failure mid-stream never reaches the error handler.
  getLogger().error({ err: error }, 'Unexpected error during a provider call');
  return { code: 'INTERNAL_ERROR', cause: error };
}

/**
 * Translates a model resolution or provider failure into the HTTP response the
 * caller sees.
 *
 * @param failure
 * A failure from model routing or toProviderFailure.
 */
export function toProviderHttpException(failure: ModelResolutionFailure | ProviderFailure): HTTPException {
  const { code } = failure;

  switch (code) {
    case 'MODEL_INVALID_ROUTING':
      return new HTTPException(400, { message: failure.message });

    case 'MODEL_NOT_FOUND':
      return new HTTPException(404, {
        message: `Model '${failure.model}' is not registered in the catalog`,
      });

    case 'MODEL_UNSUPPORTED_PROVIDER':
      return new HTTPException(400, {
        message: `Model '${failure.model}' uses provider '${failure.provider}', which this endpoint does not support`,
      });

    case 'PROVIDER_INVALID_REQUEST':
      return new HTTPException(400, {
        message: failure.message,
        cause: failure.cause,
      });

    case 'PROVIDER_REJECTED_REQUEST':
      return new HTTPException(failure.status as 400, {
        // Authentication errors can echo the supplied secret and provider URLs.
        message: `Provider error: ${failure.status === 401 ? STATUS_CODES[401] : failure.message}`,
        cause: failure.status === 401 ? undefined : failure.cause,
        res: new Response(null, { headers: { 'ai-error-source': 'upstream' } }),
      });

    case 'PROVIDER_UNAVAILABLE':
      return new HTTPException(502, {
        message: `Provider error: ${failure.message}`,
        cause: failure.cause,
      });

    case 'PROVIDER_TIMEOUT':
      return new HTTPException(504, {
        message: 'Provider error: Timed out',
        cause: failure.cause,
      });

    // The cause stays out of the response. It's ours, not the provider's.
    case 'INTERNAL_ERROR':
      return new HTTPException(500, { message: 'Internal server error' });

    default:
      return assertNever(code);
  }
}
