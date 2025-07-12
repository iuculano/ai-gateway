import { z } from '@hono/zod-openapi';
import Schemas from './inference.schemas';
import ModelService from '../models/models.services';

import { LRUCache } from 'lru-cache';

import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { generateText, type LanguageModel } from 'ai';
import { createCacheKey } from '../../clients/redis';
import { HTTPException } from 'hono/http-exception';

import LogsService from '../logs/logs.services';
import { s3 } from '../../clients/s3';


type InferenceRequest = z.infer<typeof Schemas.inferenceRequest>;
type SubmitInferenceRequest = InferenceRequest & { 
  api_key: string
  base_url?: string 
};

type InferenceResponse = z.infer<typeof Schemas.inferenceResponse>;

const providerCache = new LRUCache<string, LanguageModel>({
  max: 100,
  ttl: 1000 * 60 * 60, // 1 hour
});

async function submitInference(request: SubmitInferenceRequest): Promise<InferenceResponse> {
  // Try to find a registered model - this returns information on the model
  // such as cost. It does not return the actual LanguageModel instance.
  const model = await ModelService.getModel({
    id: request.model_id
  });

  if (!model) {
    throw new HTTPException(422, {
      cause: `Model with ID ${request.model_id} not found`,
    });
  }

  // Try to find an instantiated model instance in the cache.
  // Note that this is a local, in-memory cache - not Redis.
  const cacheKey = await createCacheKey('inference:', {
    modelId: request.model_id,
    apiKey: request.api_key,
    baseUrl: request.base_url ?? null,
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
          apiKey: request.api_key,
          baseURL: request.base_url,
        });

        instance = factory(model.name);
        break;

      case 'azure':
        factory = createAzure({
          apiKey: request.api_key,
          baseURL: request.base_url,

        });

        instance = factory(model.name);
        break;

      default:
        throw new HTTPException(400, {
          message: `Unsupported model provider: ${model.provider}`,
        });
    }
  }

  // Should have a valid LanguageModel instance now
  providerCache.set(cacheKey, instance);

  let objectData;
  if (!request.stream) {
    const response = await generateText({
      model: instance,
      messages: request.messages,
      ...(request.temperature ? { temperature: request.temperature } : {}),
      ...(request.top_p ? { topP: request.top_p } : {}),
      ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
    });

    // Write the first part of the log to the database so we can get an ID.
    // This will be missing the object_reference initially.
    const log = await LogsService.createLog({
      model: model.name,
      provider: model.provider,
      status: 'success',
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
    });

    // The actual object data that will be written to storage.
    objectData = Schemas.inferenceObjectData.parse({
      request: {
        model_id: request.model_id,
        messages: request.messages,
        temperature: request.temperature,
        top_p: request.top_p,
        max_tokens: request.max_tokens,
      },

      response: {
        id: log.id,
        text: response.text,
        reasoning: response.reasoning,
        sources: response.sources,
        usage: {
          prompt_tokens: response.usage.promptTokens,
          completion_tokens: response.usage.completionTokens,
          total_tokens: response.usage.totalTokens,
        },
        reponse_time_ms: undefined,
      }
    });

    // Compress and 
    const data = Buffer.from(JSON.stringify(objectData));
    const compressed = Bun.gzipSync(data);

    const s3Key = `/v1/logs/${log.id}.json.gz`;
    s3.file(s3Key).write(compressed);

    await LogsService.updateLog(log.id, {
      object_reference: `/v1/logs/${log.id}.json.gz`,
    });
  }

  if (objectData) {
    const parsed = Schemas.inferenceResponse.parse(objectData.response);
    return parsed;
  }
}


export default {
  submitInference
}

// Create a provider
// Create a model, bind a provider to it