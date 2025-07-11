import { z } from '@hono/zod-openapi';
import { 
  nats, 
  jsonCodec, 
  jetstream
} from "../../clients/nats";

import Schemas from './inference.schemas';
import ModelService from '../models/models.services';

import { LRUCache } from 'lru-cache';

import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { generateText, streamText, type LanguageModel } from 'ai';
import { createCacheKey } from '../../clients/redis';
import { HTTPException } from 'hono/http-exception';


type SubmitInferenceResponse = z.infer<typeof Schemas.inferenceRequest>;
type SubmitInferenceRequest = SubmitInferenceResponse & { 
  api_key: string
  base_url?: string 
};

const providerCache = new LRUCache<string, LanguageModel>({
  max: 100,
  ttl: 1000 * 60 * 60, // 1 hour
});

async function submitInference(request: SubmitInferenceRequest): Promise<void> {
  // Try to find a registered model
  const model = await ModelService.getModel({
    id: request.model_id
  });

  if (!model) {
    throw new HTTPException(422, {
      cause: `Model with ID ${request.model_id} not found`,
    });
  }

  // Try to find an instantiated model instance in the cache
  // Note that this is a local, in-memory cache - not Redis
  const cacheKey = await createCacheKey('inference:', {
    modelId: request.model_id,
    apiKey: request.api_key,
    baseUrl: request.base_url ?? null,
  });

  // Need to be careful here, these providers need to stay relatively in
  // lockstep version wise - the LanguageModel interface needs to line
  // up between them
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
          cause: `Unsupported model provider: ${model.provider}`,
        });
    }
  }

  // Should have a valid LanguageModel instance now
  providerCache.set(cacheKey, instance);

  if (!request.stream) {
    const response = await generateText({
      model: instance,
      messages: request.messages,
      ...(request.temperature ? { temperature: request.temperature } : {}),
      ...(request.top_p ? { topP: request.top_p } : {}),
      ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
    });

    const test = 1;
  }
}


  //jetstream.publish('gateway-api.inference', jsonCodec.encode(request));
}

export default {
  submitInference
}

// Create a provider
// Create a model, bind a provider to it