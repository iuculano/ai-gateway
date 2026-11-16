import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { parseTags, publicFetch } from '@repo/core';
import { type Embedding, type EmbeddingModel, embedMany } from 'ai';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  shouldFallBack,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import ModelsService from '../models/models.services';
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
 * @param provider
 * The name of the provider (e.g., 'openai', 'azure').
 *
 * @param model
 * The name of the embedding model.
 *
 * @param settings
 * Provider specific configuration such as the API key and optional base URL.
 *
 * @returns
 * The instantiated embedding model or undefined if the provider is unsupported.
 */
function createSdkEmbeddingModel(
  provider: string,
  model: string,
  settings: ProviderSettings,
): EmbeddingModel | undefined {
  // If we're overriding the base URL, we need to provide a custom fetch that
  // prevents you from calling something internal to the gateway's network.
  const config = settings.baseURL ? { ...settings, fetch: publicFetch } : settings;

  switch (provider) {
    case 'openai':
      return createOpenAI(config).embedding(model);

    case 'azure':
      return createAzure(config).embedding(model);

    case 'google':
      return createGoogleGenerativeAI(config).embedding(model);

    case 'openrouter':
      return createOpenRouter(config).textEmbeddingModel(model);

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
 * One attempt at creating embeddings, against one catalog model.
 *
 * @param info
 * The catalog model information.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @returns
 * The result of the embedding attempt.
 */
async function embedWithModel(
  info: GetModelResponse,
  headers: EmbeddingHeaders,
  body: EmbeddingBody,
): Promise<Result<EmbeddingResponse, CreateEmbeddingFailure>> {
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

  // Start the request.
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
      maxRetries: headers['ai-max-retries'] ?? 0,
      abortSignal: headers['ai-timeout-ms'] ? AbortSignal.timeout(headers['ai-timeout-ms']) : undefined,

      // Each provider reads only its own namespace.
      providerOptions: {
        openai: { dimensions: body.dimensions ?? undefined, user: body.user ?? undefined },
        google: { outputDimensionality: body.dimensions ?? undefined },
      },
    });
  } catch (error) {
    LogsService.finishLog({ ...log, status: 'failed' }, { request: body, headers: headers });

    const failure = toProviderFailure(error);
    return err(failure);
  }

  const responseTimeMs = performance.now() - startedAt;

  // The AI SDK returns NaN when the provider sent no usage. Need to turn this
  // into a null or it'll fail the log insertion.
  const tokens = Number.isFinite(result.usage.tokens) ? result.usage.tokens : null;

  const response: EmbeddingResponse = {
    object: 'list',
    data: result.embeddings.map((embedding, index) => ({
      object: 'embedding',
      index: index,
      embedding: body.encoding_format === 'base64' ? toBase64(embedding) : embedding,
    })),
    model: info.name,

    // Note that this is what we return to the user, not what we store.
    //
    // OpenAI expects a number for usage - it has no way to say "no usage."
    // 0 will skew analytic results, so we store it as NULL instead and skip it.
    usage: {
      prompt_tokens: tokens ?? 0,
      total_tokens: tokens ?? 0,
    },
  };

  LogsService.finishLog(
    {
      ...log,
      status: 'complete',
      input_tokens: tokens,
      input_cost: tokens == null || info.cost_input == null ? null : (tokens * info.cost_input) / 1_000_000,
      output_cost: 0, // Embeddings have no output cost.
      response_time_ms: Math.round(responseTimeMs),
    },
    { request: body, response: response, headers: headers },
  );

  return ok(response);
}

/**
 * Creates embeddings for one or more inputs, trying each requested model in
 * routing order until one answers.
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
  // Order the models based on the routing strategy and weights.
  const ordered = await ModelsService.validateAndOrderModels(body.model, 'embedding', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (ordered.isErr()) {
    return err(ordered.error);
  }

  // Each attempt is its own upstream call with its own log row.
  let failure: CreateEmbeddingFailure | undefined;
  for (const info of ordered.value) {
    const result = await embedWithModel(info, headers, body);
    if (result.isOk() || !shouldFallBack(result.error)) {
      return result;
    }

    failure = result.error;
  }

  // The list is never empty, so the loop ran at least once and set failure.
  return err(failure as CreateEmbeddingFailure);
}

export default {
  createEmbedding,
};
