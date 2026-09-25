import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createCacheKey, type Logger, parseTags } from '@repo/core';
import { getActorId, getCaller, getLogger } from '@repo/hono';
import {
  APICallError,
  type CallSettings,
  type FinishReason,
  generateText,
  InvalidArgumentError,
  InvalidMessageRoleError,
  InvalidPromptError,
  type JSONSchema7,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  RetryError,
  streamText,
  type ToolChoice,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from 'ai';
import { LRUCache } from 'lru-cache';
import { err, ok, type Result } from 'neverthrow';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import ModelsService from '../models/models.services';
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
type ModelNotFoundFailure = {
  code: 'MODEL_NOT_FOUND';
  model: string;
};

type UnsupportedModelProviderFailure = {
  code: 'UNSUPPORTED_MODEL_PROVIDER';
  model: string;
  provider: string;
};

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

type WebhookLogUnavailableFailure = {
  code: 'WEBHOOK_LOG_UNAVAILABLE';
};

type WebhookNotFoundFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

type ProviderInvalidRequestFailure = {
  code: 'PROVIDER_INVALID_REQUEST';
  message: string;
  cause: unknown;
};

type ProviderRejectedRequestFailure = {
  code: 'PROVIDER_REJECTED_REQUEST';
  status: number;
  message: string;
  cause: unknown;
};

type ProviderFailedFailure = {
  code: 'PROVIDER_FAILED';
  message: string;
  cause: unknown;
};

type ProviderTimeoutFailure = {
  code: 'PROVIDER_TIMEOUT';
  cause: unknown;
};

type RoutingFailure = {
  code: 'INVALID_MODEL_ROUTING';
  message: string;
};

// The public service failure unions.
export type CreateChatCompletionFailure =
  | RoutingFailure
  | ModelNotFoundFailure
  | UnsupportedModelProviderFailure
  | UnknownToolCallFailure
  | UnsupportedResponseFormatFailure
  | TopLogprobsRequiresLogprobsFailure
  | WebhookLogUnavailableFailure
  | WebhookNotFoundFailure
  | ProviderInvalidRequestFailure
  | ProviderRejectedRequestFailure
  | ProviderFailedFailure
  | ProviderTimeoutFailure;

export type StreamChatCompletionFailure = CreateChatCompletionFailure;

type ProviderFailure =
  | ProviderInvalidRequestFailure
  | ProviderRejectedRequestFailure
  | ProviderFailedFailure
  | ProviderTimeoutFailure;

/** Selects a catalog model and creates or reuses its provider instance. */
async function resolveModel(
  requestedModels: string,
  headers: ChatCompletionHeaders,
): Promise<Result<ResolvedModel, RoutingFailure | ModelNotFoundFailure | UnsupportedModelProviderFailure>> {
  const selected = await ModelsService.validateAndOrderModels(requestedModels, {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });
  if (!selected) {
    return err({ code: 'INVALID_MODEL_ROUTING', message: 'No valid models available' });
  }
  const model = selected[0] as string;
  const apiKey = headers['ai-api-key'];
  const baseUrl = headers['ai-base-url'];
  const registered = await ModelsService.getModelBySlug(model);
  if (registered.isErr()) {
    return err({ code: 'MODEL_NOT_FOUND', model });
  }

  const info = registered.value;
  if (!isProvider(info.provider)) {
    return err({ code: 'UNSUPPORTED_MODEL_PROVIDER', model, provider: info.provider });
  }

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
function toModelMessages(messages: ChatCompletionMessage[]): Result<ModelMessage[], UnknownToolCallFailure> {
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
function toCallSettings(body: ChatCompletionBody, headers: ChatCompletionHeaders): CallSettings & { timeout?: number } {
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
function toProviderOptions(body: ChatCompletionBody): Record<string, Record<string, JSONValue>> | undefined {
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
function toTools(body: ChatCompletionBody): ToolSet | undefined {
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

function toToolChoice(body: ChatCompletionBody): ToolChoice<ToolSet> | undefined {
  if (body.tool_choice == null) {
    return undefined;
  }

  if (typeof body.tool_choice === 'string') {
    return body.tool_choice;
  }

  return { type: 'tool' as const, toolName: body.tool_choice.function.name };
}

/** SDK finish reasons without an OpenAI equivalent map to stop. */
function mapFinishReason(reason: FinishReason): ChatCompletionFinishReason {
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

function toUsage(usage: LanguageModelUsage): ChatCompletionUsage {
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

function toProviderFailure(error: unknown): ProviderFailure {
  // RetryError hides the provider error that determines the response status.
  if (RetryError.isInstance(error)) {
    // An abort represents the caller's timeout rather than a provider response.
    if (error.reason === 'abort') {
      return { code: 'PROVIDER_TIMEOUT', cause: error };
    }

    return toProviderFailure(error.lastError);
  }

  // These SDK errors identify request problems before an upstream response exists.
  if (
    InvalidPromptError.isInstance(error) ||
    InvalidMessageRoleError.isInstance(error) ||
    InvalidArgumentError.isInstance(error)
  ) {
    return { code: 'PROVIDER_INVALID_REQUEST', message: error.message, cause: error };
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;

    if (status != null && status >= 400 && status < 500) {
      return { code: 'PROVIDER_REJECTED_REQUEST', status, message: error.message, cause: error };
    }

    return { code: 'PROVIDER_FAILED', message: error.message, cause: error };
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { code: 'PROVIDER_TIMEOUT', cause: error };
  }

  return { code: 'PROVIDER_FAILED', message: 'Upstream provider call failed', cause: error };
}

/** Captures request context for streaming continuations. */
interface OpenLog {
  tags?: Record<string, string>;

  id: string;
  organizationId: string;
  logger: Logger;
}

async function openLog(headers: ChatCompletionHeaders, model: ResolvedModel): Promise<OpenLog | null> {
  // Capture request-scoped state before a streaming continuation can outlive it.
  const caller = getCaller();
  const logger = getLogger();
  const organizationId = caller.organization.id;

  const tags = parseTags(headers['ai-log-tags']);

  try {
    const id = await LogsService.startLog(organizationId, {
      model: model.modelId,
      provider: model.provider,
      tags: tags,
      actor_type: caller.actor.type,
      actor_id: getActorId(caller),
    });

    return { id, organizationId, logger, tags };
  } catch (error) {
    logger.error({ err: error }, 'Failed to open inference log');
    return null;
  }
}

async function closeLog(
  log: OpenLog | null,
  headers: ChatCompletionHeaders,
  request: ChatCompletionBody,
  response: ChatCompletion,
  model: GetModelResponse,
  responseTimeMs: number,
  cacheHit: boolean,
): Promise<void> {
  if (!log) {
    return;
  }

  try {
    await LogsService.completeLog(log.organizationId, log.id, {
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
  } catch (error) {
    log.logger.error({ err: error, log_id: log.id }, 'Failed to store inference log payloads');
  }
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

async function abandonLog(
  log: OpenLog | null,
  headers: ChatCompletionHeaders,
  request: ChatCompletionBody,
): Promise<void> {
  if (!log) {
    return;
  }

  try {
    await LogsService.failLog(log.organizationId, log.id, {
      request: request,
      omitRequest: headers['ai-log-omit-request'],
    });
  } catch (error) {
    log.logger.error({ err: error, log_id: log.id }, 'Failed to mark inference log failed');
  }
}

/** Validate the webhook before incurring provider usage. */
async function queueWebhook(
  headers: ChatCompletionHeaders,
  log: OpenLog | null,
): Promise<Result<void, WebhookLogUnavailableFailure | WebhookNotFoundFailure>> {
  const webhookId = headers['ai-webhook-id'];
  if (!webhookId) {
    return ok(undefined);
  }

  // Deliveries reference a log, so a logging outage makes the requested webhook unavailable.
  if (!log) {
    return err({ code: 'WEBHOOK_LOG_UNAVAILABLE' });
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

  const messages = toModelMessages(body.messages);
  if (messages.isErr()) {
    return err(messages.error);
  }

  const model = resolved.value;
  const tools = toTools(body);
  const providerOptions = toProviderOptions(body);

  const log = await openLog(headers, model);
  if (log) {
    onLog?.(log.id);
  }

  const queued = await queueWebhook(headers, log);
  if (queued.isErr()) {
    await abandonLog(log, headers, body);
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

      ...toCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toToolChoice(body) } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    });
  } catch (error) {
    await abandonLog(log, headers, body);

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
        finish_reason: mapFinishReason(result.finishReason),
      },
    ],
    usage: toUsage(result.totalUsage),
  };

  await closeLog(log, headers, body, completion, model.info, responseTimeMs, cache.hit);

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

  const messages = toModelMessages(body.messages);
  if (messages.isErr()) {
    yield err(messages.error);
    return;
  }

  const model = resolved.value;
  const tools = toTools(body);
  const providerOptions = toProviderOptions(body);

  const log = await openLog(headers, model);
  if (log) {
    onLog?.(log.id);
  }

  const queued = await queueWebhook(headers, log);
  if (queued.isErr()) {
    await abandonLog(log, headers, body);
    yield err(queued.error);
    return;
  }

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

      ...toCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toToolChoice(body) } : {}),
      ...(providerOptions ? { providerOptions } : {}),

      // Surface SDK stream failures instead of ending the response silently.
      onError: ({ error }) => {
        streamError = toProviderFailure(error);
      },
    });
  } catch (error) {
    await abandonLog(log, headers, body);
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
        finishReason = mapFinishReason(part.finishReason);
        usage = toUsage(part.totalUsage);
        break;

      case 'error': {
        await abandonLog(log, headers, body);

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
    await abandonLog(log, headers, body);
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

  await closeLog(log, headers, body, completion, model.info, performance.now() - startedAt, cache.hit);
}

export default {
  createChatCompletion,
  streamChatCompletion,
};
