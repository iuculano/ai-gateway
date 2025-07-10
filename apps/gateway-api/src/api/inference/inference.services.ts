import { z } from '@hono/zod-openapi';
import { 
  nats, 
  jsonCodec, 
  jetstream
} from "../../clients/nats";

import Schemas from './inference.schemas';
import ModelService from '../models/models.services';
import { createHash } from 'node:crypto';

import { LRUCache } from 'lru-cache';

import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { LanguageModel } from 'ai';

type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'meta'
  | 'huggingface'
  | 'xai';

interface Provider {
  type: ProviderType
  modelId: string; // Technically this is optional, but I use it for cost estimation
  apiKey: string;
  baseUrl?: string;
  instance: LanguageModel;

}

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
  const model = await ModelService.getModel({
    id: request.model_id
  });

  const keyBase = JSON.stringify({
    model_id: request.model_id,
    api_key: request.api_key,
    base_url: request.base_url,
  });

  const cacheKey = createHash('sha1').update(keyBase).digest('hex');


  let instance;
  let factory;
  switch(model.provider) {
    case 'openai':
      factory = createOpenAI({
        apiKey: request.api_key,
        baseURL: request.base_url,
      });

      instance = factory(model.id);
      break;

    case 'azure':
      factory = createAzure({
        apiKey: request.api_key,
        baseURL: request.base_url,
      });

      instance = factory(model.id);
      break;
  }

  if (!instance) {
    throw new Error(`Unsupported provider: ${model.provider}`);
  }

  

  const cachedInstance = providerCache.get(cacheKey);
  if (!cachedInstance) {
    providerCache.set(cacheKey, instance as any);
  }

  //providerCache.set(cacheKey, provider);


  jetstream.publish('gateway-api.inference', jsonCodec.encode(request));
}

export default {
  submitInference
}

// Create a provider
// Create a model, bind a provider to it