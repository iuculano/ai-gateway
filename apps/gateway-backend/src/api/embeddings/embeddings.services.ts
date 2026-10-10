import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { type Embedding, type EmbeddingModel, embedMany } from 'ai';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  resolveModel,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import type { EmbeddingBody, EmbeddingHeaders, EmbeddingList } from './embeddings.schemas';

// The public service failure union.
export type CreateEmbeddingFailure = ModelResolutionFailure | ProviderFailure;

/** Undefined when the provider has no embedding models. */
function createModel(info: GetModelResponse, headers: EmbeddingHeaders): EmbeddingModel | undefined {
  const config = { apiKey: headers['ai-api-key'], baseURL: headers['ai-base-url'] };

  switch (info.provider) {
    case 'openai':
      return createOpenAI(config).embedding(info.name);

    case 'azure':
      return createAzure(config).embedding(info.name);

    case 'google':
      return createGoogleGenerativeAI(config).embedding(info.name);

    case 'openrouter':
      return createOpenRouter(config).textEmbeddingModel(info.name);

    default:
      return undefined;
  }
}

/**
 * Helper to convert floats to base64 representation.
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
): Promise<Result<EmbeddingList, CreateEmbeddingFailure>> {
  const resolved = await resolveModel(body.model, {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const info = resolved.value;
  const instance = createModel(info, headers);
  if (!instance) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  const logId = await LogsService.openLog('embedding', info, headers['ai-log-tags']);

  const startedAt = performance.now();

  let result: Awaited<ReturnType<typeof embedMany>>;
  try {
    result = await embedMany({
      model: instance,
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
    await LogsService.abandonLog(logId, { request: body, omitRequest: headers['ai-log-omit-request'] });

    const failure = toProviderFailure(error);
    return err(failure);
  }

  const responseTimeMs = performance.now() - startedAt;
  const tokens = result.usage.tokens;

  const response: EmbeddingList = {
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

  await LogsService.closeLog(logId, {
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
