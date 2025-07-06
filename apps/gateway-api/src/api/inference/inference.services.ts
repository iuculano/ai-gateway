import { z } from '@hono/zod-openapi';
import { 
  nats, 
  jsonCodec, 
  jetstream
} from "../../clients/nats";

import Schemas from './inference.schemas';

import { LRUCache } from 'lru-cache';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'meta'
  | 'huggingface'
  | 'xai';

type Provider = {
  id: string;
  name: string;
  type: ProviderType;
  api_key: string;
};


type SubmitInferenceResponse = z.infer<typeof Schemas.inferenceRequest>;
type SubmitInferenceRequest = SubmitInferenceResponse & { 
  api_key: string
  base_url?: string 
};



async function submitInference(request: SubmitInferenceRequest): Promise<void> {
  // Check if the model is cached


  jetstream.publish('gateway-api.inference', jsonCodec.encode(request));
}

export default {
  submitInference
}

// Create a provider
// Create a model, bind a provider to it