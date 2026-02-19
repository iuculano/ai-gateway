import ModelService from '../models/models.services';
import WebhookService from '../webhooks/webhooks.services';
import Schemas, {
  type InferenceHeaders,
  type InferenceRequest,
  type InferenceRequestSimple,
  type InferenceResponse,
  type InferenceStrategy,
} from './inference.schemas';
import { LRUCache } from 'lru-cache';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, type LanguageModel } from 'ai';
import { HTTPException } from 'hono/http-exception';
import { createCacheKey } from '@repo/core';
import { s3 } from '@repo/object-storage';
import LogsService from '../logs/logs.services';
import { type GetModelResponse } from '../models/models.schemas';



// In-memory cache for instantiated model instances.
const providerCache = new LRUCache<string, LanguageModel>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

// Simple interface around model information and the actual LanguageModel
// instance.
interface CallableModel {
  info: GetModelResponse;
  instance: LanguageModel;
};

/**
 * Gets an instance of a callable model.
 *
 * @param model
 * The model name/identifier to retrieve.
 *
 * @param apiKey
 * The API key to use for the model provider.
 *
 * @param baseUrl
 * Optional base URL for the model provider API.
 *
 * @returns
 * A promise that resolves if the response is valid, or throws an error if not.
 */
async function getCallableModel(model: string, apiKey: string, baseUrl?: string): Promise<CallableModel> {
  // Try to find a registered model first - as in a model that exists in our
  // database.
  const registeredModel = await ModelService.getModelBySlug(model);
  if (!registeredModel) {
    throw new HTTPException(404, {
      message: `Model not found: ${model}`,
    });
  }

  // Try to find an instantiated callable model instance in the cache.
  // Note that this is a local, in-memory cache - not Redis.
  const cacheKey = await createCacheKey('inference:', {
    model: model,
    apiKey: apiKey,
    baseUrl: baseUrl ?? null,
  });

  // Need to be careful here, these providers need to stay relatively in
  // lockstep version wise - the LanguageModel interface needs to line
  // up between them.
  let instance = providerCache.get(cacheKey);
  if (!instance) {
    let factory;
    switch(registeredModel.provider) {
      case 'openai':
        factory = createOpenAI({ apiKey: apiKey, baseURL: baseUrl });
        instance = factory(registeredModel.name);
        break;

      case 'azure':
        factory = createAzure({ apiKey: apiKey, baseURL: baseUrl });
        instance = factory(registeredModel.name);
        break;

      default:
        throw new HTTPException(400, {
          message: `Unsupported model provider: ${registeredModel.provider}`,
        });
    }
  }

  // Should have a valid LanguageModel instance now.
  providerCache.set(cacheKey, instance);

  const modelInfo: CallableModel = {
    info: registeredModel,
    instance: instance,
  };

  return modelInfo;
}

/**
 * Creates a new log entry for an inference request.
 *
 * @param model
 * The name of the model being used.
 *
 * @param provider
 * The provider of the model (e.g., 'openai', 'azure').
 *
 * @param status
 * Optional status for the log entry (defaults to 'incomplete').
 *
 * @returns A promise that resolves to the ID of the created log entry.
 */
async function startLog(model: string, provider: string, status?: string) : Promise<string> {
  const log = await LogsService.createLog({
    model: model,
    provider: provider,
    status: status || 'incomplete',
  });

  return log.id
}

/**
 * Updates a log entry for an inference request.
 *
 * @param id
 * The id of the log entry to update.
 *
 * @param status
 * Status for the log entry.
 *
 * @returns A promise that resolves to the ID of the created log entry.
 */
async function updateLog(id: string, status: string) : Promise<void> {
  await LogsService.updateLog(id, {
    status: status,
  });
}

/**
 * Completes a log entry for an inference request.
 *
 * This compresses and writes the request and response to storage, and then
 * updates the log entry to mark it as complete.
 *
 * @param id
 * The id of the log entry to complete.
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
async function completeLog(id: string, request: InferenceRequest, response: InferenceResponse) : Promise<void> {
  // The actual object data that will be written to object storage. This is
  // currently pretty naive and doesn't do anything like batching into a bigger
  // object.
  const objectData = Schemas.inferenceObjectData.parse({
    request: request,
    response: response,
  });

  // Compress and write it out to object storage.
  const data = Buffer.from(JSON.stringify(objectData));
  const compressed = Bun.zstdCompressSync(data, {
    level: 3,
  });

  const s3Key = `/v1/logs/${id}.json.zst`;
  await s3.file(s3Key).write(compressed);

  await LogsService.updateLog(id, {
    status: 'complete',
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    input_cost: response.usage.input_cost,
    output_cost: response.usage.output_cost,
    response_time_ms: response.response_time_ms,
    object_reference: `/v1/logs/${id}.json.zst`,
  });
}

/**
 * Helper function to pick a model based on weighted strategy.
 *
 * @param strategy
 * The inference strategy containing model targets and their weights.
 *
 * @returns
 * A promise that resolves to the selected model name.
 */
async function pickWeightedModel(strategy: InferenceStrategy) : Promise<string> {
  // Don't assume 100 total weight, sum up the weights.
  const totalWeight = strategy.targets.reduce((sum, target) => sum + (target.weight || 0), 0);

  // Say Math.random() * 100 generates 72.5.
  //
  // Iteration 1 (Model A - Weight 50)
  // 72.5 < 50 == False
  //
  // Iteration 2 (Model B - Weight 30)
  // 72.5 < 80 == True
  //
  // In other words, the number fell within the 50 to 80 range.
  const random = Math.random() * totalWeight;
  let cumulative = 0;

  for (const target of strategy.targets) {
    cumulative += target.weight || 0;
    if (random < cumulative) {
      return target.model;
    }
  }

  // Just a failsafe in case of fudged math/weights.
  if (strategy.targets[0]) {
    return strategy.targets[0].model;
  }

  // Shouldn't ever get here, but stop TypeScript complaining.
  throw new HTTPException(500);
}

/**
 * Non-streaming call to a model.
 *
 * @param headers
 * The headers containing authentication and configuration for the model
 * provider.
 *
 * @param request
 * The inference request payload.
 *
 * @returns
 * A promise that resolves to the inference response.
 */
async function callModel(headers: InferenceHeaders, request: InferenceRequestSimple): Promise<InferenceResponse> {
  const callableModel = await getCallableModel(
    request.model,
    headers['ai-api-key'],
    headers['ai-base-url'],
  );

  const log = await startLog(callableModel.info.name, callableModel.info.provider);

  let llmResponse;
  let responseTimestampStart = 0;
  let responseTimestampEnd = 0;

  try {
    responseTimestampStart = performance.now();

    llmResponse = await generateText({
      model: callableModel.instance,
      messages: request.messages,
      ...(request.parameters?.max_output_tokens ? { maxTokens: request.parameters.max_output_tokens } : {}),
      ...(request.parameters?.max_retries ? { maxRetries: request.parameters.max_retries } : {}),
      ...(request.parameters?.system_prompt ? { system: request.parameters.system_prompt } : {}),
      ...(request.parameters?.temperature ? { temperature: request.parameters.temperature } : {}),
      ...(request.parameters?.top_p ? { topP: request.parameters.top_p } : {}),
      ...(request.parameters?.top_k ? { topK: request.parameters.top_k } : {}),
    });

    responseTimestampEnd = performance.now();
  }

  catch {
    // Just eat the error, we deal with it below so we don't need to
    // do type narrowing.
    //errorReason = err;
  }

  if (!llmResponse) {
    // Failed, try the next model in the list.
    await updateLog(log, 'failed');
    throw new HTTPException(500);
  }

  let inputCost = 0;
  let outputCost = 0;
  if (llmResponse.usage && (llmResponse.usage.inputTokens && llmResponse.usage.outputTokens)) {
    inputCost = llmResponse.usage.inputTokens * (callableModel.info.cost_input / 1000000);
    outputCost = llmResponse.usage.outputTokens * (callableModel.info.cost_output / 1000000);
  }

  const response: InferenceResponse = {
    id: log,
    model: callableModel.info.name,
    provider: callableModel.info.provider,
    text: llmResponse.text,
    reasoning: llmResponse.reasoningText,
    usage: {
      input_tokens: llmResponse.usage.inputTokens ?? 0,
      output_tokens: llmResponse.usage.outputTokens ?? 0,
      input_cost: inputCost,
      output_cost: outputCost,
    },
    response_time_ms: (responseTimestampEnd - responseTimestampStart),
  }

  await completeLog(log, request, response);

  const webhookId = headers['ai-webhook-id'];
  if (webhookId) {
    await WebhookService.submitWebhookRequest(webhookId, log);
  }

  return response;
}

/**
 * Streaming call to a model.
 *
 * @param headers
 * The headers containing authentication and configuration for the model
 * provider.
 *
 * @param request
 * The inference request payload.
 *
 * @returns
 * A promise that resolves to the streaming response from the model provider.
 */
async function callModelStreaming(headers: InferenceHeaders, request: InferenceRequestSimple): Promise<AsyncIterable<string>> {
  const callableModel = await getCallableModel(
    request.model,
    headers['ai-api-key'],
    headers['ai-base-url']
  );

  const log = await startLog(callableModel.info.name, callableModel.info.provider);

  let responseTimestampStart = 0;
  let responseTimestampEnd = 0;

  responseTimestampStart = performance.now();

  const stream = await streamText({
    model: callableModel.instance,
    messages: request.messages,
    ...(request.parameters?.max_output_tokens ? { maxTokens: request.parameters.max_output_tokens } : {}),
    ...(request.parameters?.max_retries ? { maxRetries: request.parameters.max_retries } : {}),
    ...(request.parameters?.system_prompt ? { system: request.parameters.system_prompt } : {}),
    ...(request.parameters?.temperature ? { temperature: request.parameters.temperature } : {}),
    ...(request.parameters?.top_p ? { topP: request.parameters.top_p } : {}),
    ...(request.parameters?.top_k ? { topK: request.parameters.top_k } : {}),

    // Log callback
    onFinish: async (result) => {
      // Immediately capture end timestamp.
      responseTimestampEnd = performance.now();

      let inputCost = 0;
      let outputCost = 0;
      if (result.usage && (result.usage.inputTokens && result.usage.outputTokens)) {
        inputCost = result.usage.inputTokens * (callableModel.info.cost_input / 1000000);
        outputCost = result.usage.outputTokens * (callableModel.info.cost_output / 1000000);
      }

      await completeLog(log, request, {
        id: log,
        model: callableModel.info.name,
        provider: callableModel.info.provider,
        text: result.text,
        reasoning: result.reasoningText,
        usage: {
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
          input_cost: inputCost,
          output_cost: outputCost,
        },
        response_time_ms: responseTimestampEnd - responseTimestampStart,
      });
    }
  });

  return stream.textStream as AsyncIterable<string>;
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
  // Simple inference type.
  if ('model' in request) {
    return await callModel(headers, request);
  }

  // Only other shape is complex.
  if (request.strategy.mode === 'fallback') {
    let llmResponse: InferenceResponse;

    for (const target of request.strategy.targets) {
      try {
        llmResponse = await callModel(headers, {
          model: target.model,
          parameters: target.parameters,
          messages: request.messages,
        });

        return llmResponse;
      }

      catch {
        // Eat the exception and try the next model.
        continue;
      }
    }

    throw new HTTPException(500, {
      message: 'All models, including fallbacks, failed',
    });
  }

  if (request.strategy.mode === 'weighted') {
    const selectedModel = await pickWeightedModel(request.strategy);

    return await callModel(headers, {
      model: selectedModel,
      messages: request.messages,
    });
  }

  if (request.strategy.mode === 'shadowed') {
    const primaryTarget = request.strategy.targets[0];
    const shadowTargets = request.strategy.targets.slice(1);

    if (!primaryTarget) {
      throw new HTTPException(400, {
        message: 'No primary model specified for shadowed strategy',
      });
    }

    const primaryPromise = callModel(headers, {
      model: primaryTarget.model,
      parameters: primaryTarget.parameters,
      messages: request.messages,
    });


    // Start shadow calls but don't await them yet.
    const shadowPromises = shadowTargets.map(async (target) => {
      try {
        await callModel(headers, {
          model: target.model,
          parameters: target.parameters,
          messages: request.messages,
        });
      }

      catch {
        // Just eat errors from shadow models.
      }
    });

    Promise.all(shadowPromises);

    const response = await primaryPromise;
    return response;
  }

  throw new HTTPException(500, {
    message: 'Unknown inference failure',
  });
}

/**
 * Submits an inference request to a language model provider and returns a
 * streaming response.
 *
 * @param headers
 * The headers containing authentication and configuration for the model
 * provider.
 *
 * @param request
 * The inference request payload.
 *
 * @returns
 * A promise that resolves to the streaming response from the model provider.
 */
async function submitInferenceStreaming(headers: InferenceHeaders, request: InferenceRequest): Promise<AsyncIterable<string>> {
  // Simple inference type.
  if ('model' in request) {
    return await callModelStreaming(headers, request);
  }

  // Only other shape is complex.
  if (request.strategy.mode === 'fallback') {
    for (const target of request.strategy.targets) {
      try {
        return await callModelStreaming(headers, {
          model: target.model,
          parameters: target.parameters,
          messages: request.messages,
        });
      }

      catch {
        // Eat the exception and try the next model.
        continue;
      }
    }

    throw new HTTPException(500, {
      message: 'All models, including fallbacks, failed',
    });
  }

  if (request.strategy.mode === 'weighted') {
    const selectedModel = await pickWeightedModel(request.strategy);

    return await callModelStreaming(headers, {
      model: selectedModel,
      messages: request.messages,
    });
  }

  if (request.strategy.mode === 'shadowed') {
    const primaryTarget = request.strategy.targets[0];
    const shadowTargets = request.strategy.targets.slice(1);

    if (!primaryTarget) {
      throw new HTTPException(400, {
        message: 'No primary model specified for shadowed strategy',
      });
    }

    // Start shadow calls but don't await them (fire-and-forget for streaming).
    const shadowPromises = shadowTargets.map(async (target) => {
      try {
        await callModel(headers, {
          model: target.model,
          parameters: target.parameters,
          messages: request.messages,
        });
      }

      catch {
        // Just eat errors from shadow models.
      }
    });

    Promise.all(shadowPromises);

    return await callModelStreaming(headers, {
      model: primaryTarget.model,
      parameters: primaryTarget.parameters,
      messages: request.messages,
    });
  }

  throw new HTTPException(500, {
    message: 'Unknown inference failure',
  });
}

export default {
  submitInference,
  submitInferenceStreaming,
}
