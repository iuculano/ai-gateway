import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { parseTags } from '@repo/core';
import { type Embedding, type EmbeddingModel, embedMany } from 'ai';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  resolveModel,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService from '../logs/logs.services';
import type { EmbeddingBody, EmbeddingHeaders, EmbeddingResponse } from './embeddings.schemas';

// The public service failure union.
export type CreateEmbeddingFailure = ModelResolutionFailure | ProviderFailure;

interface ProviderSettings {
  apiKey: string;
  baseURL?: string;
}

/**
 * Instantiates an AI SDK embedding model based on the provider and model name.
 *
 * @param provider The name of the provider (e.g., 'openai', 'azure').
 *
 * @param model The name of the embedding model.
 *
 * @param settings Provider specific configuration such as the API key and
 * optional base URL.
 *
 * @returns
 * The instantiated embedding model or undefined if the provider is unsupported.
 */
function createSdkEmbeddingModel(
  provider: string,
  model: string,
  settings: ProviderSettings,
): EmbeddingModel | undefined {
  switch (provider) {
    case 'openai':
      return createOpenAI(settings).embedding(model);

    case 'azure':
      return createAzure(settings).embedding(model);

    case 'google':
      return createGoogleGenerativeAI(settings).embedding(model);

    case 'openrouter':
      return createOpenRouter(settings).textEmbeddingModel(model);

    default:
      return undefined;
  }
}

/**
 * Helper to convert floats to base64 representation.
 *
 * @param embedding
 * The embedding array to convert.
 *
 * @returns
 * The base64 encoded string representation of the embedding.
 */
function toBase64(embedding: Embedding): string {
  return Buffer.from(new Float32Array(embedding).buffer).toString('base64');
}

/**
 * Creates embeddings for one or more inputs.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 */
async function createEmbedding(
  headers: EmbeddingHeaders,
  body: EmbeddingBody,
): Promise<Result<EmbeddingResponse, CreateEmbeddingFailure>> {
  // Resolve the model based on the routing strategy and weights.
  const resolved = await resolveModel(body.model, 'embedding', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (resolved.isErr()) {
    return err(resolved.error);
  }

  // Should have a valid model...
  const info = resolved.value;
  const sdkModel = createSdkEmbeddingModel(info.provider, info.name, {
    apiKey: headers['ai-api-key'],
    baseURL: headers['ai-base-url'],
  });

  // The model is in the catalog, but we can't instantiate the AI SDK model...
  if (!sdkModel) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  // The OpenAI-style user field fills the well-known user_id tag, unless the
  // ai-log-tags header names one.
  const tags = parseTags(headers['ai-log-tags']) ?? {};
  if (body.user && tags.user_id === undefined) {
    tags.user_id = body.user;
  }

  const log = LogsService.startLog({
    operation: 'embedding',
    model: info.name,
    provider: info.provider,
    tags,
  });
  const startedAt = performance.now();

  //
  let result: Awaited<ReturnType<typeof embedMany>>;
  try {
    result = await embedMany({
      model: sdkModel,
      values: typeof body.input === 'string' ? [body.input] : body.input,
      maxRetries: headers['ai-max-retries'],
      abortSignal: headers['ai-timeout-ms'] ? AbortSignal.timeout(headers['ai-timeout-ms']) : undefined,

      // Each provider reads only its own namespace.
      providerOptions: {
        openai: { dimensions: body.dimensions ?? undefined, user: body.user ?? undefined },
        google: { outputDimensionality: body.dimensions ?? undefined },
      },
    });
  } catch (error) {
    LogsService.failLog(log, { request: body, omitRequest: headers['ai-log-omit-request'] });

    const failure = toProviderFailure(error);
    return err(failure);
  }

  const responseTimeMs = performance.now() - startedAt;
  const tokens = result.usage.tokens;

  const response: EmbeddingResponse = {
    object: 'list',
    data: result.embeddings.map((embedding, index) => ({
      object: 'embedding',
      index: index,
      embedding: body.encoding_format === 'base64' ? toBase64(embedding) : embedding,
    })),
    model: info.name,
    usage: {
      prompt_tokens: tokens,
      total_tokens: tokens,
    },
  };

  LogsService.completeLog(log, {
    request: body,
    response: response,
    omitRequest: headers['ai-log-omit-request'],
    omitResponse: headers['ai-log-omit-response'],
    input_tokens: tokens,
    ...(info.cost_input != null ? { input_cost: (tokens * info.cost_input) / 1_000_000 } : {}),
    response_time_ms: Math.round(responseTimeMs),
  });

  return ok(response);
}

export default {
  createEmbedding,
};
