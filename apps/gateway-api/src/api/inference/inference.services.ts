import ModelService from '../models/models.services';
import Schemas, {
  type InferenceHeaders,
  type InferenceRequest,
  type InferenceResponse,
} from './inference.schemas';
import { LRUCache } from 'lru-cache';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, type LanguageModel } from 'ai';
import { HTTPException } from 'hono/http-exception';
import { createCacheKey } from '../../clients/redis';
import { s3 } from '../../clients/s3';
import LogsService from '../logs/logs.services';
import { type GetModelResponse } from '../models/models.schemas';



const providerCache = new LRUCache<string, LanguageModel>({
  max: 100,
  ttl: 1000 * 60 * 60, // 1 hour
});

// Simple interface around model information and the actual LanguageModel
// instance.
interface CallableModel {
  info: GetModelResponse;
  instance: LanguageModel;
};

/**
 * Gets a representation of a callable model.
 *
 * @param response
 * The response from the model to validate.
 *
 * @returns
 * A promise that resolves if the response is valid, or throws an error if not.
 */
async function getCallableModel(modelId: string, apiKey: string, baseUrl?: string): Promise<CallableModel> {
  // Try to find a registered model - this returns information on the model
  // such as cost. It does not return the actual LanguageModel instance.
  const model = await ModelService.getModel(modelId);

  if (!model) {
    throw new HTTPException(422, {
      cause: `Model with ID ${modelId} not found`,
    });
  }

  // Try to find an instantiated model instance in the cache.
  // Note that this is a local, in-memory cache - not Redis.
  const cacheKey = await createCacheKey('inference:', {
    modelId: modelId,
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
          apiKey: apiKey,
          baseURL: baseUrl,
          compatibility: 'strict',
        });

        instance = factory(model.name);
        break;

      case 'azure':
        factory = createAzure({
          apiKey: apiKey,
          baseURL: baseUrl,
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

  const modelInfo: CallableModel = {
    info: model,
    instance: instance,
  };

  return modelInfo;
}

/**
 * Creates a new log entry for an inference request.
 *
 * @param modelName
 * The name of the model being used.
 *
 * @param modelProvider
 * The provider of the model (e.g., 'openai', 'azure').
 *
 * @param status
 * Optional status for the log entry (defaults to 'incomplete').
 *
 * @returns A promise that resolves to the ID of the created log entry.
 */
async function startLog(modelName: string, modelProvider: string, status?: string) : Promise<string> {
  const log = await LogsService.createLog({
    model: modelName,
    provider: modelProvider,
    status: status || 'incomplete',
  });

  return log.id
}

/**
 * Completes a log entry for an inference request by storing the request and
 * response data in object storage (compressed), and updating the log status and
 * metadata.
 *
 * @param logId
 * The ID of the log entry to complete.
 *
 * @param request
 * The original inference request object.
 *
 * @param response
 * The inference response object to log.
 *
 * @returns
 * A promise that resolves when the log entry has been updated and the data
 * stored.
 */
async function completeLog(logId: string, request: InferenceRequest, response: InferenceResponse) : Promise<void> {
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

  const s3Key = `/v1/logs/${logId}.json.gz`;
  s3.file(s3Key).write(compressed);

  await LogsService.updateLog(logId, {
    status: 'complete',
    prompt_tokens: response.usage.prompt_tokens,
    completion_tokens: response.usage.completion_tokens,
    object_reference: `/v1/logs/${logId}.json.gz`,
  });
}

/**
 * Submits a inference request to a language model provider.
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
  const model = await getCallableModel(
    request.model_id,
    headers['ai-api-key'],
    headers['ai-base-url']
  );

  // Start a log entry for this inference request.
  const logId = await startLog(model.info.name, model.info.provider);

  const llmResponse = await generateText({
    model: model.instance,
    messages: request.messages,
    ...(request.temperature ? { temperature: request.temperature } : {}),
    ...(request.top_p ? { topP: request.top_p } : {}),
    ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),
  });

  // TODO add better error handling here.
  if (!llmResponse) {
    throw new HTTPException(500, {
      message: 'Failed to generate response from model',
    });
  }

  const response = Schemas.inferenceResponse.parse({
    id: logId,
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

  await completeLog(logId, request, response);
  return response;
};

/**
 * Submits an inference request to a language model provider and returns a
 * streaming response.
 *
 * @param headers
 * The headers containing authentication and configuration for the model
 * provider.
 *
 * @param request
 * The inference request payload, including model ID and prompt details.
 *
 * @returns
 * A promise that resolves to the streaming response from the model provider.
 *
 * @remarks
 * This function also logs the inference request and response, and stores the
 * log data upon completion.
 */
async function submitInferenceStreaming(headers: InferenceHeaders, request: InferenceRequest): Promise<AsyncIterable<string>> {
  const model = await getCallableModel(
    request.model_id,
    headers['ai-api-key'],
    headers['ai-base-url']
  );

    // Start a log entry for this inference request.
  const logId = await startLog(model.info.name, model.info.provider);

  const stream = await streamText({
    model: model.instance,
    messages: request.messages,
    ...(request.temperature ? { temperature: request.temperature } : {}),
    ...(request.top_p ? { topP: request.top_p } : {}),
    ...(request.max_tokens ? { maxTokens: request.max_tokens } : {}),

    // Log callback
    onFinish: async (result) => {
      await completeLog(logId, request, {
        id: logId,
        text: result.text,
        reasoning: result.reasoning,
        sources: undefined,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
        response_time_ms: undefined,
      });
    }
  });

  return stream.textStream as AsyncIterable<string>;
};

export default {
  submitInference,
  submitInferenceStreaming,
}
