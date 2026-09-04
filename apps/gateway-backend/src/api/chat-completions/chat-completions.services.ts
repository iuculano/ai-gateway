import { randomUUID } from 'node:crypto';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createCacheKey, type Logger, parseTags } from '@repo/core';
import { getActorId, getCaller, getLogger } from '@repo/hono';
import {
  APICallError,
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
  type ToolSet,
  tool,
} from 'ai';
import { LRUCache } from 'lru-cache';
import { err, ok, type Result } from 'neverthrow';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import ModelsService from '../models/models.services';
import WebhookServices from '../webhooks/webhooks.services';
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

const providerCache = new LRUCache<string, LanguageModel>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/** The providers this gateway can reach. */
const PROVIDERS = ['openai', 'azure'] as const;

type Provider = (typeof PROVIDERS)[number];

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

interface ResolvedModel {
  provider: Provider;
  modelId: string;
  instance: LanguageModel;
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

// The public service failure unions.
export type CreateChatCompletionFailure =
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

/**
 * Resolves a request's `model` to something callable.
 *
 * @param model
 * The `model` field from the request body. May be a `provider/model` slug or
 * just a model name.
 *
 * @param apiKey
 * The caller's upstream provider credential, from the ai-api-key header.
 *
 * @param baseUrl
 * Optional override for the provider's base URL.
 *
 * @returns
 * The registered model, its callable instance, and provider metadata.
 */
async function resolveModel(
  model: string,
  apiKey: string,
  baseUrl?: string,
): Promise<Result<ResolvedModel, ModelNotFoundFailure | UnsupportedModelProviderFailure>> {
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

  // Use the chat model explicitly; the bare factory targets the Responses API.
  const instance =
    provider === 'openai'
      ? createOpenAI({ apiKey: apiKey, baseURL: baseUrl }).chat(modelId)
      : createAzure({ apiKey: apiKey, baseURL: baseUrl }).chat(modelId);

  providerCache.set(cacheKey, instance);

  return ok({ provider, modelId, instance, info });
}

/**
 * Helper to flattens OpenAI's `string | TextPart[]` content into a plain
 * string.
 */
function flattenText(content: string | Array<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/**
 * Translates OpenAI messages into the SDK's message model.
 *
 * OpenAI tool results contain only a call id, while the SDK also requires the
 * tool name. Earlier assistant calls are indexed to supply it.
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
      // `developer` is OpenAI's successor to `system`. The SDK has no separate
      // role for it, and every provider behind this gateway treats the two the
      // same way, so it is folded onto system rather than dropped.
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

        // A turn can be text, tool calls, or both. Text is only emitted when
        // there is some, so a pure tool-call turn does not carry an empty part.
        converted.push({
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text' as const, text: text }] : []),
            ...(message.tool_calls ?? []).map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.function.name,
              // OpenAI sends arguments as a JSON string; the SDK wants the
              // parsed value. A model can emit invalid JSON, so a parse failure
              // falls back to the raw string rather than failing the request.
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

/**
 * JSON.parse that yields the original string instead of throwing.
 */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Rejects parameters that are part of the OpenAI contract but that this
 * gateway cannot actually honour.
 *
 * Accepting a parameter and quietly ignoring it is worse than refusing it: the
 * caller believes it took effect. Everything named here is a 400 that says so.
 *
 * @param body
 * The validated request body.
 */
function checkSupported(
  body: ChatCompletionBody,
): Result<void, UnsupportedResponseFormatFailure | TopLogprobsRequiresLogprobsFailure> {
  // Structured output would have to be routed through the SDK's `output`
  // option, which changes the result shape and the streaming contract. Until
  // that is built, saying no is the honest answer.
  if (body.response_format && body.response_format.type !== 'text') {
    return err({ code: 'UNSUPPORTED_RESPONSE_FORMAT', response_format: body.response_format.type });
  }

  // top_logprobs is meaningless without logprobs, and OpenAI rejects the
  // combination too.
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
function toCallSettings(body: ChatCompletionBody, headers: ChatCompletionHeaders) {
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
 * Azure is OpenAI underneath and reuses the same option names, so both
 * providers read from the `openai` namespace.
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
    // Cast because zod infers a literal-typed shape that TypeScript will not
    // widen to JSONValue on its own; the value is plain JSON either way.
    ...(body.prediction != null ? { prediction: body.prediction as JSONValue } : {}),
    ...(body.service_tier != null ? { serviceTier: body.service_tier } : {}),
    ...(body.verbosity != null ? { textVerbosity: body.verbosity } : {}),
    ...(body.prompt_cache_key != null ? { promptCacheKey: body.prompt_cache_key } : {}),
    ...(body.safety_identifier != null ? { safetyIdentifier: body.safety_identifier } : {}),

    // The provider spells this with an underscore; OpenAI's wire format uses a
    // hyphen. Passing the wire spelling straight through would be rejected.
    ...(body.prompt_cache_retention != null
      ? {
          promptCacheRetention: body.prompt_cache_retention === 'in-memory' ? 'in_memory' : body.prompt_cache_retention,
        }
      : {}),

    // One field upstream: a number means "return this many alternatives",
    // a bare true means "just the chosen token".
    ...(body.logprobs ? { logprobs: body.top_logprobs ?? true } : {}),
  };

  return Object.keys(options).length > 0 ? { openai: options } : undefined;
}

/**
 * Translates OpenAI tool definitions into an SDK tool set.
 *
 * None of these carry an `execute`, which is deliberate: a gateway forwards
 * tool calls back to its caller rather than running them. Without an executor
 * the SDK stops at the tool call and hands it back, which is exactly the
 * pass-through behaviour wanted here.
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

/**
 * Translates the OpenAI tool_choice into the SDK's equivalent.
 */
function toToolChoice(body: ChatCompletionBody) {
  if (body.tool_choice == null) {
    return undefined;
  }

  if (typeof body.tool_choice === 'string') {
    return body.tool_choice;
  }

  return { type: 'tool' as const, toolName: body.tool_choice.function.name };
}

/**
 * Collapses the SDK's finish reason onto OpenAI's smaller set.
 *
 * `error` and `other` have no counterpart upstream. They land on 'stop', which
 * is lossy - but a generation that reached this point did produce a response,
 * and inventing a finish_reason outside the documented enum would break clients
 * that switch on it.
 */
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

/**
 * Translates SDK usage into the OpenAI usage block.
 */
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

/**
 * Classifies whatever the SDK threw into an expected service outcome.
 *
 * Caller-actionable provider 4xx responses are preserved; upstream failures are
 * translated to gateway failures.
 *
 * @param error
 * The thrown value.
 *
 * @returns
 * A typed failure for the handler to translate.
 */
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

  // AbortSignal.timeout() rejects with a DOMException named TimeoutError, which
  // is what the ai-timeout-ms header ends up producing.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { code: 'PROVIDER_TIMEOUT', cause: error };
  }

  return { code: 'PROVIDER_FAILED', message: 'Upstream provider call failed', cause: error };
}

/**
 * An open log, carrying the tenant and request logger so detached streaming
 * continuations do not have to look either up after the ambient scope ends.
 */
interface OpenLog {
  /** The log's tags, kept for the webhook fan-out that runs when it closes. */
  tags?: Record<string, string>;

  id: string;
  organizationId: string;
  logger: Logger;
}

/**
 * Opens a log for a call that is about to be made.
 *
 * @param headers
 * The gateway headers, carrying the ai-log-tags control.
 *
 * @param model
 * The resolved model, whose provider and id are recorded on the row.
 *
 * @returns
 * The open log, or null if it could not be opened.
 */
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

/**
 * Stores the payloads for a finished call and closes the log.
 *
 * Failures are logged but remain non-fatal because the provider response already
 * exists. Tokens and catalogue-derived costs are recorded when prices are
 * available; missing prices leave the database defaults untouched.
 *
 * @param log
 * The log opened by openLog, or null if there is none.
 *
 * @param headers
 * The gateway headers, carrying the ai-log-omit-* controls.
 *
 * @param request
 * The validated request body, stored as the request object.
 *
 * @param response
 * The completion returned to the caller, stored as the response object.
 *
 * @param model
 * The registered model whose catalogue pricing is used for accounting.
 *
 * @param responseTimeMs
 * Wall-clock time spent in the provider call.
 */
async function closeLog(
  log: OpenLog | null,
  headers: ChatCompletionHeaders,
  request: ChatCompletionBody,
  response: ChatCompletion,
  model: GetModelResponse,
  responseTimeMs: number,
): Promise<void> {
  if (!log) {
    return;
  }

  try {
    await LogsService.completeLog(log.organizationId, log.id, {
      request: request,
      response: response,
      // The row and its accounting survive either omit header; see openLog.
      omitRequest: headers['ai-log-omit-request'],
      omitResponse: headers['ai-log-omit-response'],
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      ...calculateCosts(response.usage, model),
      response_time_ms: Math.round(responseTimeMs),
    });
  } catch (error) {
    log.logger.error({ err: error, log_id: log.id }, 'Failed to store inference log payloads');
  }
}

/**
 * Calculates dollar costs from prices stored per million tokens.
 *
 * Cached input tokens use the catalogue's cache-read price when one is
 * published. If it is absent, the normal input price is used for the complete
 * input total; this is the least surprising fallback for providers that do not
 * publish a separate cache price.
 */
function calculateCosts(
  usage: ChatCompletionUsage,
  model: Pick<GetModelResponse, 'cost_input' | 'cost_output' | 'cost_cache_read'>,
): { input_cost?: number; output_cost?: number } {
  const costs: { input_cost?: number; output_cost?: number } = {};
  const cachedTokens = Math.min(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? 0);

  if (model.cost_input != null) {
    const inputTokens = usage.prompt_tokens - cachedTokens;
    const cachedInputCost =
      model.cost_cache_read == null ? cachedTokens * model.cost_input : cachedTokens * model.cost_cache_read;
    costs.input_cost = (inputTokens * model.cost_input + cachedInputCost) / 1_000_000;
  }

  if (model.cost_output != null) {
    costs.output_cost = (usage.completion_tokens * model.cost_output) / 1_000_000;
  }

  return costs;
}

/**
 * Marks a log failed, keeping the request payload for inspection.
 *
 * @param log
 * The log opened by openLog, or null if there is none.
 *
 * @param headers
 * The gateway headers, carrying the ai-log-omit-request control.
 *
 * @param request
 * The validated request body.
 */
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

/**
 * Queues the log for the webhook the request named, if it named one.
 *
 * Validation runs before inference so an invalid webhook cannot incur provider
 * usage before the request is rejected.
 *
 * @param headers
 * The gateway headers, carrying the ai-webhook-id control.
 *
 * @param log
 * The log opened for this request, or null when it could not be opened.
 *
 * @returns
 * Ok when no delivery was requested or it was queued, otherwise the expected
 * reason it could not be queued.
 */
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

/**
 * Generates a chat completion.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param onLog
 * Receives the log id in time for the handler to expose it as a response header.
 *
 * @returns
 * A completion in OpenAI's chat.completion shape, or an expected refusal.
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

  const resolved = await resolveModel(body.model, headers['ai-api-key'], headers['ai-base-url']);
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const messages = toModelMessages(body.messages);
  if (messages.isErr()) {
    return err(messages.error);
  }

  const model = resolved.value;
  const tools = toTools(body);

  const log = await openLog(headers, model);
  if (log) {
    onLog?.(log.id);
  }

  const queued = await queueWebhook(headers, log);
  if (queued.isErr()) {
    await abandonLog(log, headers, body);
    return err(queued.error);
  }

  const startedAt = performance.now();

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: model.instance,
      messages: messages.value,

      // Preserve caller message order instead of hoisting system messages into instructions.
      allowSystemInMessages: true,

      ...toCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toToolChoice(body) } : {}),
      ...(toProviderOptions(body) ? { providerOptions: toProviderOptions(body) } : {}),
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
      // Back to a JSON string, which is what the OpenAI contract specifies.
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
          // Null rather than an empty string when the turn was tool calls
          // only - clients switch on exactly this.
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

  await closeLog(log, headers, body, completion, model.info, responseTimeMs);

  return ok(completion);
}

/**
 * Generates a chat completion as a stream of chat.completion.chunk frames.
 *
 * The caller is responsible for framing these as SSE and for the terminating
 * [DONE] sentinel.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param onLog
 * Receives the log id before the handler commits the SSE response headers.
 *
 * @returns
 * Stream results; early errors can become HTTP responses, while errors after the
 * first chunk terminate the already-committed stream.
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

  const resolved = await resolveModel(body.model, headers['ai-api-key'], headers['ai-base-url']);
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

  const startedAt = performance.now();

  let streamError: ProviderFailure | undefined;

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: model.instance,
      messages: messages.value,

      // Preserve caller message order instead of hoisting system messages into instructions.
      allowSystemInMessages: true,

      ...toCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toToolChoice(body) } : {}),
      ...(toProviderOptions(body) ? { providerOptions: toProviderOptions(body) } : {}),

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

  // Provider metadata arrives only after generation, so waiting for it would
  // buffer the stream. Generate stable frame metadata up front; streamed model
  // ids therefore echo the request rather than a provider-resolved version.
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

  // Tool calls stream as fragments identified by an opaque id; the wire format
  // wants a positional index instead, so ids are assigned one on first sight.
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

        // onError has already classified this. An Err makes the handler stop
        // rather than closing the stream as if it had succeeded.
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

  // A provider that answered with nothing at all never tripped the gate above,
  // and a stream whose only frame is a finish reason is malformed. Emit the
  // opening frame it is owed first.
  if (!opened) {
    yield ok(frame({ role: 'assistant', content: '' }, null));
  }

  // The terminating frame: an empty delta plus the finish reason.
  yield ok(frame({}, finishReason));

  // Usage rides in a trailing frame with no choices, and only when asked for.
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

  // Logged only once the stream has run to completion, which is the first
  // moment the assembled response is actually final.
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
    // A provider that never sent a usage frame leaves zeroes rather than a
    // missing block, so the stored shape stays the same either way.
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  await closeLog(log, headers, body, completion, model.info, performance.now() - startedAt);
}

export default {
  createChatCompletion,
  streamChatCompletion,
};
