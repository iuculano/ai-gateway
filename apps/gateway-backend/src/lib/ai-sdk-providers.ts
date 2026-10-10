import { STATUS_CODES } from 'node:http';
import { assertNever } from '@repo/core';
import { APICallError, InvalidArgumentError, InvalidMessageRoleError, InvalidPromptError, RetryError } from 'ai';
import { HTTPException } from 'hono/http-exception';
import { err, ok, type Result } from 'neverthrow';
import type { GetModelResponse } from '../api/models/models.schemas';
import ModelsService, { type ModelRoutingOptions } from '../api/models/models.services';

// Failures from picking a catalog model for an AI SDK call.
type ModelRoutingFailure = {
  code: 'MODEL_INVALID_ROUTING';
  message: string;
};

type ModelNotFoundFailure = {
  code: 'MODEL_NOT_FOUND';
  model: string;
};

type ModelUnsupportedProviderFailure = {
  code: 'MODEL_UNSUPPORTED_PROVIDER';
  model: string;
  provider: string;
};

export type ModelResolutionFailure = ModelRoutingFailure | ModelNotFoundFailure | ModelUnsupportedProviderFailure;

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

type ProviderFailedFailure = {
  code: 'PROVIDER_FAILED';
  message: string;
  cause: unknown;
};

type ProviderTimeoutFailure = {
  code: 'PROVIDER_TIMEOUT';
  cause: unknown;
};

export type ProviderFailure =
  | ProviderInvalidRequestFailure
  | ProviderRejectedRequestFailure
  | ProviderFailedFailure
  | ProviderTimeoutFailure;

/**
 * Selects the catalog model to serve a request.
 *
 * @param requested
 * The request's model field: one 'provider/model' slug, or several to route between.
 *
 * @param routing
 * The routing strategy and weights from the gateway headers.
 *
 * @returns
 * The catalog entry. Building the SDK model from it is up to the caller.
 */
export async function resolveModel(
  requested: string,
  routing: ModelRoutingOptions,
): Promise<Result<GetModelResponse, ModelRoutingFailure | ModelNotFoundFailure>> {
  const selected = await ModelsService.validateAndOrderModels(requested, routing);
  if (!selected) {
    return err({ code: 'MODEL_INVALID_ROUTING', message: 'No valid models available' });
  }

  const model = selected[0] as string;
  const registered = await ModelsService.getModelBySlug(model);
  if (registered.isErr()) {
    return err({ code: 'MODEL_NOT_FOUND', model });
  }

  return ok(registered.value);
}

/**
 * Translates an error thrown by an AI SDK call into a typed provider failure.
 *
 * @param error
 * Whatever generateText, streamText, embedMany and friends threw.
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

  // These SDK errors identify request problems before an upstream response
  // exists.
  const isValidationError =
    InvalidPromptError.isInstance(error) ||
    InvalidMessageRoleError.isInstance(error) ||
    InvalidArgumentError.isInstance(error);

  if (isValidationError) {
    return { code: 'PROVIDER_INVALID_REQUEST', message: error.message, cause: error };
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;

    if (status != null && status >= 400 && status < 500) {
      return { code: 'PROVIDER_REJECTED_REQUEST', status, message: error.message, cause: error };
    }

    return { code: 'PROVIDER_FAILED', message: error.message, cause: error };
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { code: 'PROVIDER_TIMEOUT', cause: error };
  }

  return { code: 'PROVIDER_FAILED', message: 'Unknown error', cause: error };
}

/**
 * Translates a model resolution or provider failure into the HTTP response the
 * caller sees.
 *
 * @param failure
 * A failure from resolveModel or toProviderFailure.
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

    case 'PROVIDER_FAILED':
      return new HTTPException(502, {
        message: `Provider error: ${failure.message}`,
        cause: failure.cause,
      });

    case 'PROVIDER_TIMEOUT':
      return new HTTPException(504, {
        message: 'Provider error: Timed out',
        cause: failure.cause,
      });

    default:
      return assertNever(code);
  }
}
