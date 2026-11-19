import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { parseTags, publicFetch } from '@repo/core';
import { getCaller } from '@repo/hono';
import {
  createDownload,
  type FinishReason,
  generateText,
  type JSONSchema7,
  type JSONValue,
  jsonSchema,
  type LanguageModel,
  type LanguageModelCallOptions,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  type OutputInterface,
  type RequestOptions,
  streamText,
  type ToolChoice,
  type ToolSet,
  tool,
  wrapLanguageModel,
} from 'ai';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  shouldFallBack,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService, { type PendingLog } from '../logs/logs.services';
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

interface ProviderSettings {
  apiKey: string;
  baseURL?: string;
}

// The underlying error definitions.
type UnknownToolCallFailure = {
  code: 'UNKNOWN_TOOL_CALL';
  tool_call_id: string;
};

type WebhookNotFoundFailure = {
  code: 'WEBHOOK_NOT_FOUND';
  id: string;
};

// The public service failure unions.
export type CreateChatCompletionFailure =
  | ModelResolutionFailure
  | UnknownToolCallFailure
  | WebhookNotFoundFailure
  | ProviderFailure;

export type StreamChatCompletionFailure = CreateChatCompletionFailure;

// How long a call may keep running once its caller has left.
const ABANDONED_CALL_MS = 5 * 60_000;

/**
 * Instantiates an AI SDK chat model based on the provider and model name.
 *
 * @param provider
 * The name of the provider (e.g., 'openai', 'anthropic').
 *
 * @param model
 * The name of the chat model.
 *
 * @param settings
 * Provider specific configuration such as the API key and optional base URL.
 *
 * @returns
 * The instantiated chat model or undefined if the provider is unsupported.
 */
function createSdkChatModel(
  provider: string,
  model: string,
  settings: ProviderSettings,
): LanguageModelInstance | undefined {
  // If we're overriding the base URL, we need to provide a custom fetch that
  // prevents you from calling something internal to the gateway's network.
  const config = settings.baseURL ? { ...settings, fetch: publicFetch } : settings;

  switch (provider) {
    case 'openai':
      return createOpenAI(config).chat(model);

    case 'azure':
      return createAzure(config).chat(model);

    case 'google':
      return createGoogleGenerativeAI(config)(model);

    case 'anthropic':
      return createAnthropic(config)(model);

    case 'openrouter':
      // Only strict mode asks for usage on streams - without it a stream's
      // tokens and cost are lost.
      return createOpenRouter({ ...config, compatibility: 'strict' })(model, { usage: { include: true } });

    default:
      return undefined;
  }
}

/**
 * Flattens the content into a single string.
 *
 * It's possible to submit content as an array of objects. This function
 * normalizes it into a single string.
 *
 * @param content
 * The content to flatten, either a string or an array of text parts.
 *
 * @returns
 * The flattened string content.
 */
function normalizeContent(content: string | Array<{ type: 'text'; text: string }>): string {
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
          role: 'system', // AI SDK treats both 'system' and 'developer' as 'system'
          content: normalizeContent(message.content),
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
                    : {
                        type: 'image' as const,
                        image: part.image_url.url,
                        ...(part.image_url.detail // Forwwward image detail setting for OpenAI
                          ? { providerOptions: { openai: { imageDetail: part.image_url.detail } } }
                          : {}),
                      },
                ),
        });
        break;

      case 'assistant': {
        for (const call of message.tool_calls ?? []) {
          toolNamesByCallId.set(call.id, call.function.name);
        }

        const text = message.content == null ? '' : normalizeContent(message.content);

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
              output: { type: 'text', value: normalizeContent(message.content) },
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
 * Try to fall back on a parse failure.
 *
 * Seems possible in some edge cases like a tool call getting cut off by
 * `max_tokens`.
 *
 * This feels a bit hacky and I kind of hate it...
 *
 * @param value
 * The JSON string to parse.
 *
 * @returns
 * The parsed object, or an empty object if parsing fails.
 */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Convert the request body and headers into the SDK's call settings.
 *
 * This is effectively a translation from OpenAI's request format to the AI
 * SDK's call settings.
 *
 * @param body
 * The validated request body.
 *
 * @param headers
 * The gateway headers, which carry the retry and timeout overrides.
 *
 * @returns
 * The SDK call settings.
 */
function toSdkCallSettings(
  body: ChatCompletionBody,
  headers: ChatCompletionHeaders,
): LanguageModelCallOptions & RequestOptions {
  // `max_completion_tokens` supersedes `max_tokens`
  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;

  // Seems like this isn't guaranteed to return a string... it can actually wind
  // up as a string array???
  const stopSequences = body.stop == null ? undefined : typeof body.stop === 'string' ? [body.stop] : body.stop;

  return {
    ...(maxOutputTokens != null ? { maxOutputTokens: maxOutputTokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { topP: body.top_p } : {}),
    ...(body.presence_penalty != null ? { presencePenalty: body.presence_penalty } : {}),
    ...(body.frequency_penalty != null ? { frequencyPenalty: body.frequency_penalty } : {}),
    ...(body.seed != null ? { seed: body.seed } : {}),
    ...(stopSequences?.length ? { stopSequences: stopSequences } : {}),
    ...(body.reasoning_effort != null ? { reasoning: body.reasoning_effort } : {}),
    ...(headers['ai-timeout-ms'] != null ? { timeout: headers['ai-timeout-ms'] } : {}),
    maxRetries: headers['ai-max-retries'] ?? 0, // OpenAI SDK retries on its own, make this opt in
  };
}

/**
 * Convert the request body into AI SDK provider-specific options.
 *
 * @param body
 * The validated request body.
 *
 * @param provider
 * The provider name.
 *
 * @returns
 * The provider-specific options, or undefined if none are applicable.
 */
function toSdkProviderOptions(
  body: ChatCompletionBody,
  provider: string,
): Record<string, Record<string, JSONValue>> | undefined {
  // Normalize some provider-specific options...
  if (provider === 'openrouter') {
    const options: Record<string, JSONValue> = {
      ...(body.user != null ? { user: body.user } : {}),
      ...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
      ...(body.reasoning_effort != null ? { reasoning: { effort: body.reasoning_effort } } : {}),
    };

    return Object.keys(options).length > 0 ? { openrouter: options } : undefined;
  }

  const strict = body.response_format?.type === 'json_schema' ? body.response_format.json_schema.strict : undefined;

  const options: Record<string, JSONValue> = {
    ...(body.logit_bias != null ? { logitBias: body.logit_bias } : {}),
    ...(body.parallel_tool_calls != null ? { parallelToolCalls: body.parallel_tool_calls } : {}),
    ...(body.user != null ? { user: body.user } : {}),
    ...(body.store != null ? { store: body.store } : {}),
    ...(body.metadata != null ? { metadata: body.metadata } : {}),
    ...(body.prediction != null ? { prediction: body.prediction as JSONValue } : {}),
    ...(body.service_tier != null ? { serviceTier: body.service_tier } : {}),
    ...(body.verbosity != null ? { textVerbosity: body.verbosity } : {}),
    ...(body.prompt_cache_key != null ? { promptCacheKey: body.prompt_cache_key } : {}),
    ...(body.safety_identifier != null ? { safetyIdentifier: body.safety_identifier } : {}),
    ...(body.response_format?.type === 'json_schema' ? { strictJsonSchema: strict ?? false } : {}), // The AI SDK makes schemas strict unless told otherwise, and OpenAI doesn't.

    // The SDK uses in_memory; the request uses in-memory.
    ...(body.prompt_cache_retention != null
      ? {
          promptCacheRetention: body.prompt_cache_retention === 'in-memory' ? 'in_memory' : body.prompt_cache_retention,
        }
      : {}),
  };

  return Object.keys(options).length > 0 ? { openai: options } : undefined;
}

/**
 * Converts OpenAI tool definitions into an AI SDK tool set.
 *
 * @param body
 * The validated request body.
 *
 * @returns
 * The corresponding AI SDK tool set, or undefined if no tools are defined.
 */
function toSdkTools(body: ChatCompletionBody): ToolSet | undefined {
  if (!body.tools?.length) {
    return undefined;
  }

  const tools: ToolSet = {};
  for (const definition of body.tools) {
    tools[definition.function.name] = tool({
      ...(definition.function.description ? { description: definition.function.description } : {}),
      ...(definition.function.strict != null ? { strict: definition.function.strict } : {}),
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

/**
 * The SDK's plain text output, asking the provider for JSON. The text passes
 * through unparsed, where Output.json() would fail on anything that isn't valid.
 *
 * @param body
 * The validated request body.
 */
function toSdkOutput(body: ChatCompletionBody): OutputInterface<string, string, never> | undefined {
  const format = body.response_format;
  if (!format || format.type === 'text') {
    return undefined;
  }

  const responseFormat =
    format.type === 'json_object'
      ? { type: 'json' as const }
      : {
          type: 'json' as const,
          name: format.json_schema.name,
          ...(format.json_schema.description ? { description: format.json_schema.description } : {}),
          ...(format.json_schema.schema ? { schema: format.json_schema.schema as JSONSchema7 } : {}),
        };

  return { ...Output.text(), responseFormat: Promise.resolve(responseFormat) };
}

/**
 * Convert AI SDK finish reasons into OpenAI's shape.
 *
 * @param reason
 * The finish reason from the SDK.
 *
 * @returns
 * The corresponding OpenAI finish reason.
 */
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

/**
 * Convert AI SDK usage into OpenAI's usage shape.
 *
 * @param usage
 * The usage information from the AI SDK.
 *
 * @returns
 * The usage information in OpenAI's shape, or undefined if not available.
 */
function toOpenAIUsage(usage: LanguageModelUsage): ChatCompletionUsage | undefined {
  // Something probably went wrong, but some providers can also deliberately
  // omit usage information (like OpenRouter, seemingly).
  if (usage.inputTokens == null && usage.outputTokens == null) {
    return undefined;
  }

  // OpenAI seems to always set a value for these.
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;

  // OpenAI ALSO seemingly always sets these, but we differentiate to make
  // logging clearer / to give it a clear "unknown" marker.
  const cachedTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(cachedTokens != null || cacheWriteTokens != null
      ? {
          prompt_tokens_details: {
            cached_tokens: cachedTokens ?? 0,
            ...(cacheWriteTokens != null ? { cache_write_tokens: cacheWriteTokens } : {}),
          },
        }
      : {}),
    ...(reasoningTokens != null ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}),
  };
}

/**
 * Builds a chat.completion.
 *
 * @param fields
 * What goes into it.
 */
function toCompletion(fields: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls: ChatCompletionToolCall[];
  finishReason: ChatCompletionFinishReason;
  usage: ChatCompletionUsage | undefined;
}): ChatCompletion {
  return {
    id: fields.id,
    object: 'chat.completion',
    created: fields.created,
    model: fields.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: fields.text.length > 0 ? fields.text : null,
          refusal: null,
          ...(fields.toolCalls.length > 0 ? { tool_calls: fields.toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: fields.finishReason,
      },
    ],
    ...(fields.usage ? { usage: fields.usage } : {}),
  };
}

/**
 * Builds one chat.completion.chunk of a stream.
 *
 * @param frame
 * The id, timestamp and model every chunk of the stream shares.
 *
 * @param delta
 * What this chunk adds.
 *
 * @param finishReason
 * Why the answer ended, on the last chunk only.
 */
function toChunk(
  frame: { id: string; created: number; model: string },
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finishReason: ChatCompletionFinishReason | null,
): ChatCompletionChunk {
  return {
    id: frame.id,
    object: 'chat.completion.chunk',
    created: frame.created,
    model: frame.model,
    choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
  };
}

/**
 * What a call cost, from the catalog's prices or from what the provider says it
 * charged.
 *
 * @param usage
 * The usage the provider reported, if any.
 *
 * @param model
 * The catalog entry, with its per-million-token prices.
 *
 * @param reportedCost
 * What the provider says it charged, when it says. It wins over the catalog.
 */
function calculateCosts(
  usage: ChatCompletionUsage | undefined,
  model: Pick<GetModelResponse, 'cost_input' | 'cost_output' | 'cost_cache_read' | 'config'>,
  reportedCost?: number,
): { input_cost: number | null; output_cost: number | null } {
  let input: number | null = null;
  let output: number | null = null;

  // The catalog estimate. Cache reads and writes have their own prices, and
  // fall back to the plain input price when the catalog has none.
  if (usage && model.cost_input != null && model.cost_output != null) {
    const details = usage.prompt_tokens_details;
    const cachedTokens = Math.min(usage.prompt_tokens, details?.cached_tokens ?? 0);
    const writtenTokens = Math.min(usage.prompt_tokens - cachedTokens, details?.cache_write_tokens ?? 0);

    // The catalog keeps the write price in config, and null there means unknown.
    const writePrice = model.config?.cost_cache_write;
    const cacheCost =
      cachedTokens * (model.cost_cache_read ?? model.cost_input) +
      writtenTokens * (typeof writePrice === 'number' ? writePrice : model.cost_input);
    input = ((usage.prompt_tokens - cachedTokens - writtenTokens) * model.cost_input + cacheCost) / 1_000_000;
    output = (usage.completion_tokens * model.cost_output) / 1_000_000;
  }

  // If the provider didn't report a cost, use the catalog estimate.
  // Null when there's no usage or no catalog price.
  if (reportedCost == null) {
    return { input_cost: input, output_cost: output };
  }

  // The provider reported one total, but the log keeps input and output apart.
  // With no estimate to split it by, the whole charge goes on input, so the
  // total is still exact.
  if (input == null || output == null || input + output <= 0) {
    return { input_cost: reportedCost, output_cost: 0 };
  }

  // Otherwise split it in the same proportions as the catalog estimate. If the
  // catalog put 80% of the cost on input, so does the reported charge.
  const estimated = input + output;
  return {
    input_cost: (reportedCost * input) / estimated,
    output_cost: (reportedCost * output) / estimated,
  };
}

/**
 * What OpenRouter says it charged, which can differ from the catalog when it
 * routes to a pricier upstream. Other providers report no cost.
 *
 * @param provider
 * The provider that answered.
 *
 * @param usage
 * The call's usage, with the provider's own usage object as `raw`.
 */
function reportedCostOf(provider: string, usage: LanguageModelUsage): number | undefined {
  const raw = usage.raw as
    | { cost?: number; is_byok?: boolean; cost_details?: { upstream_inference_cost?: number | null } }
    | undefined;
  if (provider !== 'openrouter' || typeof raw?.cost !== 'number') {
    return undefined;
  }

  // With your own provider key (BYOK), cost is only OpenRouter's fee and the
  // upstream's charge comes separately. Added only then, so a call on
  // OpenRouter's own keys can't be counted twice.
  return raw.cost + (raw.is_byok ? (raw.cost_details?.upstream_inference_cost ?? 0) : 0);
}

/** Everything a call needs once the request has been checked and its log opened. */
interface Prepared {
  log: PendingLog;
  cache: { hit: boolean };
  call: SdkCall;
}

/** The options both generateText and streamText get. */
type SdkCall = LanguageModelCallOptions &
  RequestOptions & {
    model: LanguageModelInstance;
    messages: ModelMessage[];
    output?: OutputInterface<string, string, never>;
    allowSystemInMessages: true;
    tools?: ToolSet;
    toolChoice?: ToolChoice<ToolSet>;
    providerOptions?: Record<string, Record<string, JSONValue>>;
    abortSignal: AbortSignal;
    experimental_download: typeof downloadImages;
  };

// The SDK downloads images itself for models that can't fetch a URL, holding each
// in memory. Its default cap is 2 GB, sized for any file type, so images get a
// cap near the largest the providers accept.
const downloadImage = createDownload({ maxBytes: 20 * 1024 * 1024 });

/**
 * Downloads the images a model can't fetch for itself, each capped in size.
 *
 * @param requests
 * The URLs in the request, and whether the model can fetch each one itself.
 */
async function downloadImages(requests: { url: URL; isUrlSupportedByModel: boolean }[]) {
  const downloads = [];
  for (const request of requests) {
    // Null leaves the URL for the model to fetch itself.
    downloads.push(request.isUrlSupportedByModel ? null : downloadImage({ url: request.url }));
  }
  return Promise.all(downloads);
}

/**
 * A signal that aborts some time after the caller has left, and never while
 * they're still waiting.
 *
 * @param caller
 * The caller's own signal, which aborts when they disconnect.
 *
 * @param ms
 * How long the call gets after that.
 */
export function abandonedCallSignal(caller: AbortSignal | undefined, ms = ABANDONED_CALL_MS): AbortSignal {
  const controller = new AbortController();
  caller?.addEventListener('abort', () => setTimeout(() => controller.abort(), ms).unref(), { once: true });
  return controller.signal;
}

/**
 * Checks a request, instantiates the model and starts the log for one attempt.
 *
 * @param info
 * The catalog model to call.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param signal
 * Aborts when the caller disconnects.
 */
async function prepareWithModel(
  info: GetModelResponse,
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  signal: AbortSignal | undefined,
): Promise<Result<Prepared, CreateChatCompletionFailure>> {
  const sdkModel = createSdkChatModel(info.provider, info.name, {
    apiKey: headers['ai-api-key'],
    baseURL: headers['ai-base-url'],
  });

  // The model is in the catalog, but we can't instantiate the AI SDK model...
  if (!sdkModel) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  const messages = toSdkMessages(body.messages);
  if (messages.isErr()) {
    return err(messages.error);
  }

  // The OpenAI-style user field fills the well-known user_id tag, unless the
  // ai-log-tags header names one.
  const tags = parseTags(headers['ai-log-tags']) ?? {};
  if (body.user && tags.user_id === undefined) {
    tags.user_id = body.user;
  }

  // Start the request.
  const log = LogsService.startLog({
    operation: 'chat',
    model: info.name,
    provider: info.provider,
    tags,
  });

  // Checked before the provider is called, so a bad id costs nothing upstream.
  const webhookId = headers['ai-webhook-id'];
  if (webhookId) {
    const queued = await WebhookServices.enqueueDelivery(webhookId, log.id);

    if (queued.isErr()) {
      LogsService.finishLog({ ...log, status: 'failed' }, { request: body, headers: headers });
      return err({ code: 'WEBHOOK_NOT_FOUND', id: queued.error.id });
    }
  }

  // The gateway cache, when the caller turned it on.
  let model: LanguageModelInstance = sdkModel;
  const cache = { hit: false };
  if (headers['ai-cache-enabled']) {
    const namespace = {
      organizationId: getCaller().organization.id,
      provider: info.provider,
      modelId: info.name,
      apiKey: headers['ai-api-key'],
      baseUrl: headers['ai-base-url'] ?? null,
    };

    model = wrapLanguageModel({
      model: sdkModel,
      middleware: createCacheMiddleware(namespace, cache, {
        ttl: headers['ai-cache-ttl'] ?? 300,
        refresh: headers['ai-cache-refresh'] ?? false,
      }),
    });
  }

  const output = toSdkOutput(body);
  const tools = toSdkTools(body);
  const providerOptions = toSdkProviderOptions(body, info.provider);

  return ok({
    log,
    cache,
    call: {
      model,
      messages: messages.value,
      ...(output ? { output } : {}),
      // The SDK refuses system messages in `messages` unless told otherwise, and
      // OpenAI callers put them there.
      allowSystemInMessages: true,
      ...toSdkCallSettings(body, headers),
      ...(tools ? { tools: tools, toolChoice: toSdkToolChoice(body) } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      abortSignal: abandonedCallSignal(signal),
      experimental_download: downloadImages,
    },
  });
}

/**
 * One attempt at a whole completion, against one catalog model.
 *
 * @param info
 * The catalog model to call.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param signal
 * Aborts when the caller disconnects.
 *
 * @returns
 * The completion, or why the attempt failed.
 */
async function generateWithModel(
  info: GetModelResponse,
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  signal: AbortSignal | undefined,
): Promise<Result<ChatCompletion, CreateChatCompletionFailure>> {
  const prepared = await prepareWithModel(info, headers, body, signal);
  if (prepared.isErr()) {
    return err(prepared.error);
  }

  const { call, log, cache } = prepared.value;
  const startedAt = performance.now();

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText(call);
  } catch (error) {
    LogsService.finishLog(
      { ...log, status: signal?.aborted ? 'incomplete' : 'failed' },
      { request: body, headers: headers },
    );
    return err(toProviderFailure(error));
  }

  const completion = toCompletion({
    id: result.finalStep.response.id,
    created: Math.floor(result.finalStep.response.timestamp.getTime() / 1000),
    model: result.finalStep.response.modelId,
    text: result.text,
    toolCalls: result.toolCalls.map((call) => ({
      id: call.toolCallId,
      type: 'function' as const,
      function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
    })),
    finishReason: toOpenAIFinishReason(result.finishReason),
    usage: toOpenAIUsage(result.usage),
  });

  const usage = completion.usage;
  LogsService.finishLog(
    {
      ...log,
      status: signal?.aborted ? 'incomplete' : 'complete', // The caller dropped, but the provider finished and billed it.
      gateway_cache_hit: cache.hit,
      input_tokens: usage?.prompt_tokens ?? null,
      cached_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      output_tokens: usage?.completion_tokens ?? null,
      ...(cache.hit // A cache hit never reached the provider.
        ? { input_cost: 0, output_cost: 0 }
        : calculateCosts(usage, info, reportedCostOf(info.provider, result.usage))),
      response_time_ms: Math.round(performance.now() - startedAt),
    },
    { request: body, response: completion, headers: headers },
  );

  return ok(completion);
}

/**
 * Generates a whole chat completion, trying each requested model in routing
 * order until one answers.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param signal
 * Aborts when the caller disconnects.
 */
async function createChatCompletion(
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  signal?: AbortSignal,
): Promise<Result<ChatCompletion, CreateChatCompletionFailure>> {
  // Order the models based on the routing strategy and weights.
  const ordered = await ModelsService.validateAndOrderModels(body.model, 'chat', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (ordered.isErr()) {
    return err(ordered.error);
  }

  // Each attempt is its own upstream call with its own log row. A caller who
  // has left gets no further attempts.
  let failure: CreateChatCompletionFailure | undefined;
  for (const info of ordered.value) {
    const result = await generateWithModel(info, headers, body, signal);
    if (result.isOk() || !shouldFallBack(result.error) || signal?.aborted) {
      return result;
    }

    failure = result.error;
  }

  // The list can't be empty, so the loop ran at least once and set failure.
  return err(failure as CreateChatCompletionFailure);
}

/**
 * One attempt at a streamed completion, against one catalog model.
 *
 * @param info
 * The catalog model to call.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param signal
 * Aborts when the caller disconnects.
 *
 * @returns
 * Chunks as they arrive, ending with a failure if the attempt fails.
 */
async function* streamWithModel(
  info: GetModelResponse,
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  signal: AbortSignal | undefined,
): AsyncGenerator<Result<ChatCompletionChunk, StreamChatCompletionFailure>> {
  const prepared = await prepareWithModel(info, headers, body, signal);
  if (prepared.isErr()) {
    yield err(prepared.error);
    return;
  }

  const { call, log, cache } = prepared.value;

  try {
    const startedAt = performance.now();
    let streamError: ProviderFailure | undefined;

    // Provider failures arrive later, as error or abort parts in the stream.
    const result = streamText({
      ...call,
      // Surface SDK stream failures instead of ending the response silently.
      onError: ({ error }) => {
        streamError = toProviderFailure(error);
      },
    });

    // Generated here so frames don't wait for the provider's metadata.
    const frame = {
      id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
      created: Math.floor(Date.now() / 1000),
      model: info.name,
    };

    // OpenAI chunks identify tool calls by index; the SDK uses IDs.
    const toolCallIndexes = new Map<string, number>();

    // Delay the first yield until the provider responds so rejections can still
    // use a non-200 status.
    let opened = false;

    let finishReason: ChatCompletionFinishReason = 'stop';
    let usage: ChatCompletionUsage | undefined;
    let reportedCost: number | undefined;

    // A provider always says why it stopped. Apartial answer mustn't pass as a
    // finished one.
    let finished = false;

    // Reassembled so streamed and whole requests log the same response shape.
    let text = '';
    const toolCalls: ChatCompletionToolCall[] = [];

    for await (const part of result.stream) {
      // `start` is local-only; wait for a provider part before committing the 200.
      if (!opened && part.type !== 'start' && part.type !== 'error' && part.type !== 'abort') {
        opened = true;

        // OpenAI's first frame announces the role and carries no content.
        yield ok(toChunk(frame, { role: 'assistant', content: '' }, null));
      }

      switch (part.type) {
        case 'text-delta':
          if (part.text) {
            text += part.text;
            yield ok(toChunk(frame, { content: part.text }, null));
          }
          break;

        case 'tool-input-start': {
          const index = toolCallIndexes.size;
          toolCallIndexes.set(part.id, index);
          toolCalls.push({ id: part.id, type: 'function', function: { name: part.toolName, arguments: '' } });

          yield ok(
            toChunk(
              frame,
              { tool_calls: [{ index: index, id: part.id, type: 'function', function: { name: part.toolName } }] },
              null,
            ),
          );
          break;
        }

        case 'tool-input-delta': {
          const index = toolCallIndexes.get(part.id);
          const call = index == null ? undefined : toolCalls[index];
          if (index != null && call && part.delta) {
            call.function.arguments += part.delta;
            yield ok(toChunk(frame, { tool_calls: [{ index: index, function: { arguments: part.delta } }] }, null));
          }
          break;
        }

        case 'tool-input-end': {
          // Some providers send no argument fragments for a call that takes none, and
          // clients parse the arguments as JSON, where an empty string isn't valid.
          const index = toolCallIndexes.get(part.id);
          const call = index == null ? undefined : toolCalls[index];
          if (index != null && call?.function.arguments === '') {
            call.function.arguments = '{}';
            yield ok(toChunk(frame, { tool_calls: [{ index: index, function: { arguments: '{}' } }] }, null));
          }
          break;
        }

        case 'finish-step':
          reportedCost = reportedCostOf(info.provider, part.usage);
          break;

        case 'finish':
          finished = part.rawFinishReason !== undefined;
          finishReason = toOpenAIFinishReason(part.finishReason);
          usage = toOpenAIUsage(part.totalUsage);
          break;

        // The ai-timeout-ms timeout, or the cap on a call whose caller has left.
        // A failure either way, so a partial answer can't pass as a finished one.
        case 'abort':
          LogsService.finishLog(
            { ...log, status: signal?.aborted ? 'incomplete' : 'failed' },
            { request: body, headers: headers },
          );
          yield err({ code: 'PROVIDER_TIMEOUT', cause: undefined });
          return;

        case 'error':
          LogsService.finishLog({ ...log, status: 'failed' }, { request: body, headers: headers });
          yield err(streamError ?? toProviderFailure(part.error));
          return;

        default:
          // Reasoning, sources, files, step boundaries and raw provider frames
          // have no place in the chat.completion.chunk shape.
          break;
      }
    }

    if (streamError || !finished) {
      LogsService.finishLog({ ...log, status: 'failed' }, { request: body, headers: headers });
      yield err(
        streamError ?? {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The provider stream ended before it finished',
          cause: undefined,
        },
      );
      return;
    }

    // Empty streams still need an opening role frame.
    if (!opened) {
      yield ok(toChunk(frame, { role: 'assistant', content: '' }, null));
    }

    yield ok(toChunk(frame, {}, finishReason));

    if (body.stream_options?.include_usage && usage) {
      yield ok({ ...toChunk(frame, {}, null), choices: [], usage: usage });
    }

    LogsService.finishLog(
      {
        ...log,
        status: signal?.aborted ? 'incomplete' : 'complete', // The caller left, but the provider finished and billed it.
        gateway_cache_hit: cache.hit,
        input_tokens: usage?.prompt_tokens ?? null,
        cached_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        ...(cache.hit ? { input_cost: 0, output_cost: 0 } : calculateCosts(usage, info, reportedCost)), // A cache hit never reached the provider.
        response_time_ms: Math.round(performance.now() - startedAt),
      },
      { request: body, response: toCompletion({ ...frame, text, toolCalls, finishReason, usage }), headers: headers },
    );
  } finally {
    // A consumer that stops reading early leaves the log open, and it closes
    // here. A log that's already closed stays as it was.
    LogsService.finishLog({ ...log, status: 'incomplete' }, { request: body, headers: headers });
  }
}

/**
 * Generates a chat completion as a stream of chunks, trying each requested
 * model in routing order until one starts answering.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @param signal
 * Aborts when the caller disconnects.
 */
async function* streamChatCompletion(
  headers: ChatCompletionHeaders,
  body: ChatCompletionBody,
  signal?: AbortSignal,
): AsyncGenerator<Result<ChatCompletionChunk, StreamChatCompletionFailure>> {
  // Order the models based on the routing strategy and weights.
  const ordered = await ModelsService.validateAndOrderModels(body.model, 'chat', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (ordered.isErr()) {
    yield err(ordered.error);
    return;
  }

  const models = ordered.value;
  for (const [index, info] of models.entries()) {
    const hasNext = index < models.length - 1;

    // Falls back only before anything has gone out. Once the caller has part of
    // an answer, another model can't continue it.
    let started = false;
    let fellBack = false;

    for await (const result of streamWithModel(info, headers, body, signal)) {
      if (!started && hasNext && result.isErr() && shouldFallBack(result.error) && !signal?.aborted) {
        fellBack = true;
        break;
      }

      started = true;
      yield result;
    }

    if (!fellBack) {
      return;
    }
  }
}

export default {
  createChatCompletion,
  streamChatCompletion,
};
