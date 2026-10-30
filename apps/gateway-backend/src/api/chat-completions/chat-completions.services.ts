import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createCacheKey, parseTags } from '@repo/core';
import { getCaller } from '@repo/hono';
import {
  type CallSettings,
  type FinishReason,
  generateText,
  type JSONSchema7,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type ToolChoice,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from 'ai';
import { LRUCache } from 'lru-cache';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  resolveModel as resolveCatalogModel,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService, { type PendingLog } from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import WebhookServices from '../webhooks/webhooks.services';
import { createCacheMiddleware } from './chat-completions.cache';
import type {
  ChatCompletion,
  ChatCompletionBody,
  ChatCompletionChunk,
  ChatCompletionFinishReason,
  ChatCompletionHeaders,
  ChatCompletionMessage,
  ChatCompletionToolCall,
  ChatCompletionUsage,
} from './chat-completions.schemas';

// Exclude string model IDs - wrapLanguageModel requires a model instance.
type LanguageModelInstance = Exclude<LanguageModel, string>;

const providerCache = new LRUCache<string, LanguageModelInstance>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

const PROVIDERS = ['openai', 'azure', 'google', 'anthropic', 'openrouter'] as const;

type Provider = (typeof PROVIDERS)[number];

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

interface ResolvedModel {
  provider: Provider;
  modelId: string;
  instance: LanguageModelInstance;
  info: GetModelResponse;
}

// The underlying error definitions.
type UnknownToolCallFailure = {
  code: 'UNKNOWN_TOOL_CALL';
  tool_call_id: string;
};

type UnsupportedResponseFormatFailure = {
  code: 'UNSUPPORTED_RESPONSE_FORMAT';
  response_format: string;
};

type TopLogprobsRequiresLogprobsFailure = {
  code: 'TOP_LOGPROBS_REQUIRES_LOGPROBS';
};

type WebhookNotFoundFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

// The public service failure unions.
export type CreateChatCompletionFailure =
  | ModelResolutionFailure
  | UnknownToolCallFailure
  | UnsupportedResponseFormatFailure
  | TopLogprobsRequiresLogprobsFailure
  | WebhookNotFoundFailure
  | ProviderFailure;

export type StreamChatCompletionFailure = CreateChatCompletionFailure;

/** Selects a catalog model and creates or reuses its provider instance. */
async function resolveModel(
  requestedModels: string,
  headers: ChatCompletionHeaders,
): Promise<Result<ResolvedModel, ModelResolutionFailure>> {
  const resolved = await resolveCatalogModel(requestedModels, 'chat', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const info = resolved.value;
  if (!isProvider(info.provider)) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  const apiKey = headers['ai-api-key'];
  const baseUrl = headers['ai-base-url'];

  const provider = info.provider;
  const modelId = info.name;

  const cacheKey = createCacheKey('chat-completions:', {
    provider: provider,
    modelId: modelId,
    apiKey: apiKey,
    baseUrl: baseUrl ?? null,
  });

  const cached = providerCache.get(cacheKey);
  if (cached) {
    return ok({ provider, modelId, instance: cached, info });
  }

  const config = { apiKey: apiKey, baseURL: baseUrl };
  let instance: LanguageModelInstance;
  switch (provider) {
    case 'openai':
      instance = createOpenAI(config).chat(modelId);
      break;
    case 'azure':
      instance = createAzure(config).chat(modelId);
      break;
    case 'google':
      instance = createGoogleGenerativeAI(config)(modelId);
      break;
    case 'anthropic':
      instance = createAnthropic(config)(modelId);
      break;
    case 'openrouter':
      instance = createOpenRouter(config)(modelId);
      break;
  }

  providerCache.set(cacheKey, instance);

  return ok({ provider, modelId, instance, info });
}

function flattenText(content: string | Array<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/**
 * Translates OpenAI messages into the SDK's message model.
 *
 * @param messages
 * The request's messages, in order.
 *
 * @returns
 * The equivalent SDK messages.
 */
function toSdkMessages(messages: ChatCompletionMessage[]): Result<ModelMessage[], UnknownToolCallFailure> {
  const toolNamesByCallId = new Map<string, string>();
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        converted.push({
          role: 'system',
          content: flattenText(message.content),
        });
        break;

      case 'user':
        converted.push({
          role: 'user',
          content:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) =>
                  part.type === 'text'
                    ? { type: 'text' as const, text: part.text }
                    : { type: 'image' as const, image: part.image_url.url },
                ),
        });
        break;

      case 'assistant': {
        for (const call of message.tool_calls ?? []) {
          toolNamesByCallId.set(call.id, call.function.name);
        }

        const text = message.content == null ? '' : flattenText(message.content);

        converted.push({
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text' as const, text: text }] : []),
            ...(message.tool_calls ?? []).map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.function.name,
              input: safeParseJson(call.function.arguments),
            })),
          ],
        });
        break;
      }

      case 'tool': {
        const toolName = toolNamesByCallId.get(message.tool_call_id);
        if (!toolName) {
          return err({ code: 'UNKNOWN_TOOL_CALL', tool_call_id: message.tool_call_id });
        }

        converted.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.tool_call_id,
              toolName: toolName,
              output: { type: 'text', value: flattenText(message.content) },
            },
          ],
        });
        break;
      }
    }
  }

  return ok(converted);
}

/** Preserves malformed tool arguments as a string. */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function checkSupported(
  body: ChatCompletionBody,
): Result<void, UnsupportedResponseFormatFailure | TopLogprobsRequiresLogprobsFailure> {
  // Structured output needs the SDK's output option, which is not implemented here.
  if (body.response_format && body.response_format.type !== 'text') {
    return err({ code: 'UNSUPPORTED_RESPONSE_FORMAT', response_format: body.response_format.type });
  }

  if (body.top_logprobs != null && !body.logprobs) {
    return err({ code: 'TOP_LOGPROBS_REQUIRES_LOGPROBS' });
  }

  return ok(undefined);
}

/**
 * The generation settings that map onto the SDK's own call options.
 *
 * @param body
 * The validated request body.
 *
 * @param headers
 * The gateway headers, which carry the retry and timeout overrides.
 */
function toSdkCallSettings(
  body: ChatCompletionBody,
  headers: ChatCompletionHeaders,
): CallSettings & { timeout?: number } {
  // max_completion_tokens supersedes max_tokens upstream, so it wins here too.
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  const stopSequences = body.stop == null ? undefined : typeof body.stop === 'string' ? [body.stop] : body.stop;

  return {
    ...(maxOutputTokens != null ? { maxOutputTokens: maxOutputTokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { topP: body.top_p } : {}),
    ...(body.presence_penalty != null ? { presencePenalty: body.presence_penalty } : {}),
    ...(body.frequency_penalty != null ? { frequencyPenalty: body.frequency_penalty } : {}),
    ...(body.seed != null ? { seed: body.seed } : {}),
    ...(stopSequences?.length ? { stopSequences: stopSequences } : {}),
    ...(headers['ai-max-retries'] != null ? { maxRetries: headers['ai-max-retries'] } : {}),
    ...(headers['ai-timeout-ms'] != null ? { timeout: headers['ai-timeout-ms'] } : {}),
  };
}

/**
 * The settings that have no cross-provider equivalent and ride along in the
 * provider's own namespace.
 *
 * @param body
 * The validated request body.
 */
function toSdkProviderOptions(body: ChatCompletionBody): Record<string, Record<string, JSONValue>> | undefined {
  const options: Record<string, JSONValue> = {
    ...(body.logit_bias != null ? { logitBias: body.logit_bias } : {}),
    ...(body.parallel_tool_calls != null ? { parallelToolCalls: body.parallel_tool_calls } : {}),
    ...(body.user != null ? { user: body.user } : {}),
    ...(body.reasoning_effort != null ? { reasoningEffort: body.reasoning_effort } : {}),
    ...(body.store != null ? { store: body.store } : {}),
    ...(body.metadata != null ? { metadata: body.metadata } : {}),
    ...(body.prediction != null ? { prediction: body.prediction as JSONValue } : {}),
    ...(body.service_tier != null ? { serviceTier: body.service_tier } : {}),
    ...(body.verbosity != null ? { textVerbosity: body.verbosity } : {}),
    ...(body.prompt_cache_key != null ? { promptCacheKey: body.prompt_cache_key } : {}),
    ...(body.safety_identifier != null ? { safetyIdentifier: body.safety_identifier } : {}),

    // The SDK uses in_memory; the request uses in-memory.
    ...(body.prompt_cache_retention != null
      ? {
          promptCacheRetention: body.prompt_cache_retention === 'in-memory' ? 'in_memory' : body.prompt_cache_retention,
        }
      : {}),

    // The SDK accepts true or the number of alternative tokens.
    ...(body.logprobs ? { logprobs: body.top_logprobs ?? true } : {}),
  };

  return Object.keys(options).length > 0 ? { openai: options } : undefined;
}

/**
 * Translates OpenAI tool definitions into an SDK tool set.
 *
 * @param body
 * The validated request body.
 */
function toSdkTools(body: ChatCompletionBody): ToolSet | undefined {
  if (!body.tools?.length) {
    return undefined;
  }

  const tools: ToolSet = {};
  for (const definition of body.tools) {
    tools[definition.function.name] = tool({
      ...(definition.function.description ? { description: definition.function.description } : {}),
      inputSchema: jsonSchema((definition.function.parameters ?? { type: 'object', properties: {} }) as JSONSchema7),
    });
  }

  return tools;
}

function toSdkToolChoice(body: ChatCompletionBody): ToolChoice<ToolSet> | undefined {
  if (body.tool_choice == null) {
    return undefined;
  }

  if (typeof body.tool_choice === 'string') {
    return body.tool_choice;
  }

  return { type: 'tool' as const, toolName: body.tool_choice.function.name };
}

/** SDK finish reasons without an OpenAI equivalent map to stop. */
function toOpenAIFinishReason(reason: FinishReason): ChatCompletionFinishReason {
  switch (reason) {
    case 'length':
      return 'length';

    case 'content-filter':
      return 'content_filter';

    case 'tool-calls':
      return 'tool_calls';

    default:
      return 'stop';
  }
}

function toOpenAIUsage(usage: LanguageModelUsage): ChatCompletionUsage {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;

  const cachedTokens = usage.inputTokenDetails?.cacheReadTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(cachedTokens != null ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(reasoningTokens != null ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
  };
}

function closeLog(
  log: PendingLog,
  headers: ChatCompletionHeaders,
  request: ChatCompletionBody,
  response: ChatCompletion,
  model: GetModelResponse,
  responseTimeMs: number,
  cacheHit: boolean,
): void {
  LogsService.completeLog(log, {
    request: request,
    response: response,
    // Omit headers exclude payloads, not usage or costs.
    omitRequest: headers['ai-log-omit-request'],
    omitResponse: headers['ai-log-omit-response'],
    gateway_cache_hit: cacheHit,
    input_tokens: response.usage.prompt_tokens,
    cached_input_tokens: response.usage.prompt_tokens_details?.cached_tokens ?? null,
    output_tokens: response.usage.completion_tokens,
    ...(cacheHit ? { input_cost: 0, output_cost: 0 } : calculateCosts(response.usage, model)),
    response_time_ms: Math.round(responseTimeMs),
  });
}

function calculateCosts(
  usage: ChatCompletionUsage,
  model: Pick<GetModelResponse, 'cost_input' | 'cost_output' | 'cost_cache_read'>,
): { input_cost?: number; output_cost?: number } {
  const costs: { input_cost?: number; output_cost?: number } = {};
  const cachedTokens = Math.min(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? 0);

  if (model.cost_input != null) {
    const inputTokens = usage.prompt_tokens - cachedTokens;
    const cachedInputCost = cachedTokens * (model.cost_cache_read ?? model.cost_input);
    costs.input_cost = (inputTokens * model.cost_input + cachedInputCost) / 1_000_000;
  }

  if (model.cost_output != null) {
    costs.output_cost = (usage.completion_tokens * model.cost_output) / 1_000_000;
  }

  return costs;
}

function abandonLog(
  log: PendingLog,
  headers: ChatCompletionHeaders,
  request: ChatCompletionBody,
  status: 'failed' | 'incomplete' = 'failed',
): void {
  LogsService.failLog(log, { request: request, omitRequest: headers['ai-log-omit-request'] }, status);
}

/** Validate the webhook before incurring provider usage. */
async function queueWebhook(
  headers: ChatCompletionHeaders,
  log: PendingLog,
): Promise<Result<void, WebhookNotFoundFailure>> {
  const webhookId = headers['ai-webhook-id'];
  if (!webhookId) {
    return ok(undefined);
  }

  const queued = await WebhookServices.enqueueDelivery(webhookId, log.id);

  if (queued.isErr()) {
    return err({ code: 'WEBHOOK_NOT_FOUND', id: queued.error.id });
  }

  return ok(undefined);
}

function cacheModel(
  model: ResolvedModel,
  headers: ChatCompletionHeaders,
  cache: { hit: boolean },
): LanguageModelInstance {
  if (!headers['ai-cache-enabled']) {
    return model.instance;
  }

  const caller = getCaller();

  const scope = createCacheKey('chat-completions:scope:', {
    organizationId: caller.organization.id,
    provider: model.provider,
    modelId: model.modelId,
    apiKey: headers['ai-api-key'],
    baseUrl: headers['ai-base-url'] ?? null,
  });

  return wrapLanguageModel({
    model: model.instance,
    middleware: createCacheMiddleware(scope, cache, {
      ttl: headers['ai-cache-ttl'] ?? 300,
      refresh: headers['ai-cache-refresh'] ?? false,
    }),
  });
}

/**
 * Generate a non-streaming chat completion.
 *
 */
async function createChatCompletion(
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  onLog?: (logId: string) => void,
): Promise<Result<ChatCompletion, CreateChatCompletionFailure>> {
  const supported = checkSupported(body);
  if (supported.isErr()) {
    return err(supported.error);
  }

  const resolved = await resolveModel(body.model, headers);
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const messages = toSdkMessages(body.messages);
  if (messages.isErr()) {
    return err(messages.error);
  }

  const model = resolved.value;
  const tools = toSdkTools(body);
  const providerOptions = toSdkProviderOptions(body);

  // The OpenAI-style user field fills the well-known user_id tag, unless the
  // ai-log-tags header names one.
  const tags = parseTags(headers['ai-log-tags']) ?? {};
  if (body.user && tags.user_id === undefined) {
    tags.user_id = body.user;
  }

  const log = LogsService.startLog({
    operation: 'chat',
    model: model.modelId,
    provider: model.provider,
    tags,
  });
  onLog?.(log.id);

  const queued = await queueWebhook(headers, log);
  if (queued.isErr()) {
    abandonLog(log, headers, body);
    return err(queued.error);
  }

  const cache = { hit: false };
  const startedAt = performance.now();

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: cacheModel(model, headers, cache),
      messages: messages.value,

      // Preserve caller message order instead of hoisting system messages into instructions.
      allowSystemInMessages: true,

      ...toSdkCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toSdkToolChoice(body) } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    });
  } catch (error) {
    abandonLog(log, headers, body);

    return err(toProviderFailure(error));
  }

  const responseTimeMs = performance.now() - startedAt;

  const toolCalls = result.toolCalls.map((call) => ({
    id: call.toolCallId,
    type: 'function' as const,
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.input ?? {}),
    },
  }));

  const completion: ChatCompletion = {
    id: result.response.id,
    object: 'chat.completion',
    created: Math.floor(result.response.timestamp.getTime() / 1000),
    model: result.response.modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text.length > 0 ? result.text : null,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: toOpenAIFinishReason(result.finishReason),
      },
    ],
    usage: toOpenAIUsage(result.totalUsage),
  };

  closeLog(log, headers, body, completion, model.info, responseTimeMs, cache.hit);

  return ok(completion);
}

/**
 * Generates a a stream of chat completion chunks.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param onLog
 * Receives the log id before the handler commits the SSE response headers.
 */
async function* streamChatCompletion(
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  onLog?: (logId: string) => void,
): AsyncGenerator<Result<ChatCompletionChunk, StreamChatCompletionFailure>> {
  const supported = checkSupported(body);
  if (supported.isErr()) {
    yield err(supported.error);
    return;
  }

  const resolved = await resolveModel(body.model, headers);
  if (resolved.isErr()) {
    yield err(resolved.error);
    return;
  }

  const messages = toSdkMessages(body.messages);
  if (messages.isErr()) {
    yield err(messages.error);
    return;
  }

  const model = resolved.value;
  const tools = toSdkTools(body);
  const providerOptions = toSdkProviderOptions(body);

  // The OpenAI-style user field fills the well-known user_id tag, unless the
  // ai-log-tags header names one.
  const tags = parseTags(headers['ai-log-tags']) ?? {};
  if (body.user && tags.user_id === undefined) {
    tags.user_id = body.user;
  }

  const log = LogsService.startLog({
    operation: 'chat',
    model: model.modelId,
    provider: model.provider,
    tags,
  });
  onLog?.(log.id);

  const queued = await queueWebhook(headers, log);
  if (queued.isErr()) {
    abandonLog(log, headers, body);
    yield err(queued.error);
    return;
  }

  // A consumer that stops iterating early (the client disconnected) skips the
  // settles below; the finally records that call as 'incomplete'.
  let settled = false;

  try {
    const cache = { hit: false };
    const startedAt = performance.now();

    let streamError: ProviderFailure | undefined;

    let result: ReturnType<typeof streamText>;
    try {
      result = streamText({
        model: cacheModel(model, headers, cache),
        messages: messages.value,

        // Preserve caller message order instead of hoisting system messages into instructions.
        allowSystemInMessages: true,

        ...toSdkCallSettings(body, headers),
        ...(tools ? { tools: tools, toolChoice: toSdkToolChoice(body) } : {}),
        ...(providerOptions ? { providerOptions } : {}),

        // Surface SDK stream failures instead of ending the response silently.
        onError: ({ error }) => {
          streamError = toProviderFailure(error);
        },
      });
    } catch (error) {
      settled = true;
      abandonLog(log, headers, body);
      yield err(toProviderFailure(error));
      return;
    }

    // Generate metadata locally to avoid waiting for the provider to finish.
    const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = model.modelId;

    const frame = (
      delta: ChatCompletionChunk['choices'][number]['delta'],
      finishReason: ChatCompletionFinishReason | null,
    ): ChatCompletionChunk => ({
      id: id,
      object: 'chat.completion.chunk',
      created: created,
      model: modelId,
      choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
    });

    // OpenAI chunks identify tool calls by index; the SDK uses IDs.
    const toolCallIndexes = new Map<string, number>();

    // Delay the first yield until the provider responds so rejections can still
    // use a non-200 status.
    let opened = false;

    let finishReason: ChatCompletionFinishReason = 'stop';
    let usage: ChatCompletionUsage | undefined;

    // Reassemble chunks so streaming and non-streaming logs share one response shape.
    let assembledText = '';
    const assembledToolCalls: ChatCompletionToolCall[] = [];

    for await (const part of result.fullStream) {
      // `start` is local-only; wait for a provider part before committing the 200.
      if (!opened && part.type !== 'start' && part.type !== 'error') {
        opened = true;

        // OpenAI's first frame announces the role and carries no content.
        yield ok(frame({ role: 'assistant', content: '' }, null));
      }

      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            assembledText += part.text;
            yield ok(frame({ content: part.text }, null));
          }
          break;

        case 'tool-input-start': {
          const index = toolCallIndexes.size;
          toolCallIndexes.set(part.id, index);
          assembledToolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.toolName, arguments: '' },
          });

          yield ok(
            frame(
              {
                tool_calls: [{ index: index, id: part.id, type: 'function', function: { name: part.toolName } }],
              },
              null,
            ),
          );
          break;
        }

        case 'tool-input-delta': {
          const index = toolCallIndexes.get(part.id);
          if (index != null && part.delta) {
            const accumulating = assembledToolCalls[index];
            if (accumulating) {
              accumulating.function.arguments += part.delta;
            }

            yield ok(frame({ tool_calls: [{ index: index, function: { arguments: part.delta } }] }, null));
          }
          break;
        }

        case 'finish':
          finishReason = toOpenAIFinishReason(part.finishReason);
          usage = toOpenAIUsage(part.totalUsage);
          break;

        case 'error': {
          settled = true;
          abandonLog(log, headers, body);

          yield err(streamError ?? toProviderFailure(part.error));
          return;
        }

        default:
          // Reasoning, sources, files, step boundaries and raw provider frames
          // have no place in the chat.completion.chunk shape.
          break;
      }
    }

    if (streamError) {
      settled = true;
      abandonLog(log, headers, body);
      yield err(streamError);
      return;
    }

    // Empty streams still need an opening role frame.
    if (!opened) {
      yield ok(frame({ role: 'assistant', content: '' }, null));
    }

    yield ok(frame({}, finishReason));

    if (body.stream_options?.include_usage && usage) {
      yield ok({
        id: id,
        object: 'chat.completion.chunk',
        created: created,
        model: modelId,
        choices: [],
        usage: usage,
      });
    }

    const completion: ChatCompletion = {
      id: id,
      object: 'chat.completion',
      created: created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: assembledText.length > 0 ? assembledText : null,
            refusal: null,
            ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
          },
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    settled = true;
    closeLog(log, headers, body, completion, model.info, performance.now() - startedAt, cache.hit);
  } finally {
    if (!settled) {
      abandonLog(log, headers, body, 'incomplete');
    }
  }
}

export default {
  createChatCompletion,
  streamChatCompletion,
};
