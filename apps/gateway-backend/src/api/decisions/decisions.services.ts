import { createOpenAI } from '@ai-sdk/openai';
import type {
  Experimental_DecisionModelV4 as DecisionModel,
  Experimental_DecisionModelV4Answer as SdkAnswer,
  Experimental_DecisionModelV4Question as SdkQuestion,
  Experimental_DecisionModelV4Result as SdkResult,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { parseTags, publicFetch } from '@repo/core';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  shouldFallBack,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import ModelsService from '../models/models.services';
import type { CreateDecisionBody, CreateDecisionHeaders, CreateDecisionResponse } from './decisions.schemas';

type Question = CreateDecisionBody['questions'][number];
type ScoreLevel = Extract<Question, { type: 'score' }>['levels'][number];
type Answer = CreateDecisionResponse['answers'][number];

// The public service failure union.
export type CreateDecisionFailure = ModelResolutionFailure | ProviderFailure;

interface ProviderSettings {
  apiKey: string;
  baseURL?: string;
}

/**
 * Instantiates an AI SDK decision model based on the provider and model name.
 *
 * @param provider
 * The name of the provider (e.g., 'openai', 'azure').
 *
 * @param model
 * The name of the decision model.
 *
 * @param settings
 * Provider specific configuration such as the API key and optional base URL.
 *
 * @returns
 * The instantiated decision model or undefined if the provider is unsupported.
 */
function createSdkDecisionModel(
  provider: string,
  model: string,
  settings: ProviderSettings,
): DecisionModel | undefined {
  // If we're overriding the base URL, we need to provide a custom fetch that
  // prevents you from calling something internal to the gateway's network.
  const config = settings.baseURL ? { ...settings, fetch: publicFetch } : settings;

  switch (provider) {
    case 'openai':
      return createOpenAI(config).decisionModel(model);

    case 'typesafe-ai':
      return createTypeSafeAi(config).decisionModel(model);

    // seemingly unsupported
    // case 'openrouter':
    //   return createOpenRouter(config).decisionModel(model);

    default:
      return undefined;
  }
}

/**
 * Transform an OpenAI question into the AI SDK shape.
 *
 * @param question
 * The original OpenAI shaped question object.
 *
 * @returns
 * The transformed question in the AI SDK format.
 */
function toSdkQuestion(question: Question): SdkQuestion {
  switch (question.type) {
    case 'predicate':
      return { type: 'boolean', instructions: question.instructions };

    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(question.choices.map((choice) => [choice.value, choice.description])),
      };

    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels.map((level) => `${level.label}: ${level.description}`),
      };
  }
}

/**
 * Convert the AI SDK's confidence metadata into OpenAI's expected format.
 *
 * @param metadata
 * The AI SDK's shared provider metadata.
 *
 * @param name
 * The name of the question, used as the key to look up the confidence score.
 *
 * @returns
 * The confidence score for the given question, or undefined if not available.
 */
function toOpenAIConfidence(metadata: SharedV4ProviderMetadata | undefined, name: string): number | undefined {
  // Kind of nasty, Providers report confidence in their own metadata namespace,
  // keyed by question name.
  for (const namespace of Object.values(metadata ?? {})) {
    const confidence = namespace.confidence as Record<string, number> | undefined;
    if (confidence?.[name] != null) {
      return confidence[name];
    }
  }

  return undefined;
}

/**
 * Translates the SDK's answer back into OpenAI's format.
 *
 * @param question
 * The original question object.
 *
 * @param answer
 * The SDK's answer object.
 *
 * @param confidence
 * The confidence score for the answer, if available.
 *
 * @returns
 * The answer in OpenAI's expected format.
 */
function toOpenAIAnswer(question: Question, answer: SdkAnswer, confidence: number | undefined): Answer {
  // Need to get the name from the original question object, it's not included
  // on the SDK's answer shape.
  const name = question.name;

  switch (answer.type) {
    case 'refusal':
      return { type: 'refusal', name: name };

    case 'boolean':
      return { type: 'predicate', name: name, probability: answer.probability };

    case 'choice':
      return {
        type: 'choice',
        name: name,
        choice: answer.choice,
        probabilities: Object.entries(answer.probabilities ?? {}).map(([value, probability]) => ({
          value: value,
          probability: probability,
        })),
        confidence: confidence,
      };

    case 'score': {
      // Keyed by level index - the labels come back from the request.
      const levels = (question as { levels: ScoreLevel[] }).levels;

      return {
        type: 'score',
        name: name,
        score: answer.score,
        probabilities: Object.entries(answer.probabilities ?? {}).map(([value, probability]) => ({
          value: Number(value),
          label: (levels[Number(value)] as ScoreLevel).label,
          probability: probability,
        })),
        confidence: confidence,
      };
    }
  }
}

/**
 * One attempt at creating a decision, against one catalog model.
 *
 * @param info
 * The catalog model information.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @returns
 * The result of the decision attempt.
 */
async function decideWithModel(
  info: GetModelResponse,
  headers: CreateDecisionHeaders,
  body: CreateDecisionBody,
): Promise<Result<CreateDecisionResponse, CreateDecisionFailure>> {
  // Actually create the SDK model instance.
  const sdkModel = createSdkDecisionModel(info.provider, info.name, {
    apiKey: headers['ai-api-key'],
    baseURL: headers['ai-base-url'],
  });

  if (!sdkModel) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  // Start the decision call.
  const log = LogsService.startLog({
    operation: 'decision',
    model: info.name,
    provider: info.provider,
    tags: parseTags(headers['ai-log-tags']),
  });

  const startedAt = performance.now();

  // decide() throws away every answer when any one question is refused, where
  // OpenAI returns the refusal alongside the rest.
  //
  // doDecide() instead of the experimental decide() allows this behavior.
  let result: SdkResult;
  try {
    const questions: Record<string, SdkQuestion> = {};
    for (const question of body.questions) {
      questions[question.name] = toSdkQuestion(question);
    }

    result = await sdkModel.doDecide({
      state: body.input,
      questions: questions,
      abortSignal: headers['ai-timeout-ms'] ? AbortSignal.timeout(headers['ai-timeout-ms']) : undefined,
      providerOptions: {
        openai: { safetyIdentifier: body.safety_identifier ?? undefined },
      },
    });
  } catch (error) {
    LogsService.finishLog({ ...log, status: 'failed' }, { request: body, headers: headers });

    const providerFailure = toProviderFailure(error);
    return err(providerFailure);
  }

  const responseTimeMs = performance.now() - startedAt;
  // Null when the provider sent no usage, so the log records the cost as
  // unknown rather than free (which messes with analytics).
  //
  //The response still says 0, since OpenAI's usage fields are plain numbers
  // with no way to say unknown.
  const inputTokens = result.usage?.inputTokens ?? null;
  const outputTokens = result.usage?.outputTokens ?? null;

  const response: CreateDecisionResponse = {
    model: result.response?.modelId ?? info.name,
    answers: body.questions.map((question) =>
      toOpenAIAnswer(
        question,
        result.answers[question.name] as SdkAnswer,
        toOpenAIConfidence(result.providerMetadata, question.name),
      ),
    ),
    usage: {
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
      total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    },
  };

  LogsService.finishLog(
    {
      ...log,
      status: 'complete',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_cost: inputTokens == null || info.cost_input == null ? null : (inputTokens * info.cost_input) / 1_000_000,
      output_cost: 0, // Only input is billed for a decision.
      response_time_ms: Math.round(responseTimeMs),
    },
    { request: body, response: response, headers: headers },
  );

  return ok(response);
}

/**
 * Answers typed questions about one input, trying each requested model in
 * routing order until one answers.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 *
 * @returns
 * The result of the decision creation.
 */
async function createDecision(
  headers: CreateDecisionHeaders,
  body: CreateDecisionBody,
): Promise<Result<CreateDecisionResponse, CreateDecisionFailure>> {
  // Order the models based on the routing strategy and weights.
  const ordered = await ModelsService.validateAndOrderModels(body.model, 'decision', {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (ordered.isErr()) {
    return err(ordered.error);
  }

  // Each attempt is its own upstream call with its own log row.
  let failure: CreateDecisionFailure | undefined;
  for (const info of ordered.value) {
    const result = await decideWithModel(info, headers, body);
    if (result.isOk() || !shouldFallBack(result.error)) {
      return result;
    }

    failure = result.error;
  }

  // The list is never empty, so the loop ran at least once and set failure.
  return err(failure as CreateDecisionFailure);
}

export default {
  createDecision,
};
