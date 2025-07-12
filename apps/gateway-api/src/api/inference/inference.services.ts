import ModelService from '../models/models.services';
import Schemas, {
  type InferenceHeaders,
  type InferenceRequest,
  type InferenceResponse,
} from './inference.schemas';
import { LRUCache } from 'lru-cache';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type LanguageModel } from 'ai';
import { HTTPException } from 'hono/http-exception';
import { createCacheKey } from '../../clients/redis';
import { s3 } from '../../clients/s3';
import LogsService from '../logs/logs.services';


const providerCache = new LRUCache<string, LanguageModel>({
  max: 100,
  ttl: 1000 * 60 * 60, // 1 hour
});

/**
 * Submits a logged inference request to a language model provider.
 *
 * @param headers The headers containing authentication and configuration for
 * the model provider.
 *
 * @param request The inference request payload, including model ID and prompt
 * details.
 *
 * @returns
 * A promise that resolves to the inference response.
 *
 * @throws {HTTPException}
 * If the model is not found, the provider is unsupported, or inference fails.
 */
async function submitInference(headers: InferenceHeaders, request: InferenceRequest): Promise<InferenceResponse> {
  // Try to find a registered model - this returns information on the model
  // such as cost. It does not return the actual LanguageModel instance.
  const model = await ModelService.getModel(request.model_id);

  if (!model) {
    throw new HTTPException(422, {
      cause: `Model with ID ${request.model_id} not found`,
    });
  }

  // Try to find an instantiated model instance in the cache.
  // Note that this is a local, in-memory cache - not Redis.
  const apiKey = headers['ai-api-key'];
  const baseUrl = headers['ai-base-url'];

  const cacheKey = await createCacheKey('inference:', {
    modelId: request.model_id,
    apiKey: apiKey,
    baseUrl: baseUrl ?? null,
  });

  // Need to be careful here, these providers need to stay relatively in
  // lockstep version wise - the LanguageModel interface needs to line
  // up between them.
  let instance = providerCache.get(cacheKey);
  if (!instance) {
    let factory;
    switch(model.provider) {
      case 'openai':
        factory = createOpenAI({
          apiKey: headers['ai-api-key'],
          baseURL: headers['ai-base-url'],
        });

        instance = factory(model.name);
        break;

      case 'azure':
        factory = createAzure({
          apiKey: headers['ai-api-key'],
          baseURL: headers['ai-base-url'],
        });

        instance = factory(model.name);
        break;

      default:
        throw new HTTPException(400, {
          message: `Unsupported model provider: ${model.provider}`,
        });
    }
  }

  // Should have a valid LanguageModel instance now. If we already had one, this
  // will be a no-op.
  providerCache.set(cacheKey, instance);

  // Start the inference request.
  let llmResponse;
  if (!request.stream) {
    llmResponse = await generateText({
      model: instance,
      messages: request.messages,
      ...(request.temperature ? { temperature: request.temperature } : {}),
      ...(request.top_p ? { topP: request.top_p } : {}),
      ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
    });
  };

  // TODO add better error handling here.
  if (!llmResponse) {
    throw new HTTPException(500, {
      message: 'Failed to generate response from model',
    });
  }

  // Write the first part of the log to the database so we can get an ID.
  // This will be missing a few things initially.
  //
  // If we haven't thrown yet, the request was at least passably successful...
  const log = await LogsService.createLog({
    model: model.name,
    provider: model.provider,
    status: 'incomplete',
  });

  // Try to build a valid response up front.
  const response = Schemas.inferenceResponse.parse({
    id: log.id,
    text: llmResponse.text,
    reasoning: llmResponse.reasoning,
    sources: llmResponse.sources,
    usage: {
      prompt_tokens: llmResponse.usage.promptTokens,
      completion_tokens: llmResponse.usage.completionTokens,
      total_tokens: llmResponse.usage.totalTokens,
    },
    response_time_ms: undefined,
  });

  // The actual object data that will be written to object storage. This is
  // currently pretty naive and doesn't do anything like batching into a bigger
  // object.
  const objectData = Schemas.inferenceObjectData.parse({
    request: request,
    response: response,
  });

  // Compress and write it out to object storage.
  const data = Buffer.from(JSON.stringify(objectData));
  const compressed = Bun.gzipSync(data);

  const s3Key = `/v1/logs/${log.id}.json.gz`;
  s3.file(s3Key).write(compressed);

  await LogsService.updateLog(log.id, {
    object_reference: `/v1/logs/${log.id}.json.gz`,
  });

  return response;
};

export default {
  submitInference
}
