import { createOpenAI } from '@ai-sdk/openai';
import type {
  Experimental_DecisionModelV4 as DecisionModel,
  Experimental_DecisionModelV4Answer as SdkAnswer,
  Experimental_DecisionModelV4Question as SdkQuestion,
  Experimental_DecisionModelV4Result as SdkResult,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { err, ok, type Result } from 'neverthrow';
import {
  type ModelResolutionFailure,
  type ProviderFailure,
  resolveModel,
  toProviderFailure,
} from '../../lib/ai-sdk-providers';
import LogsService from '../logs/logs.services';
import type { GetModelResponse } from '../models/models.schemas';
import type { CreateDecisionBody, CreateDecisionHeaders, CreateDecisionResponse } from './decisions.schemas';

type Question = CreateDecisionBody['questions'][number];
type ScoreLevel = Extract<Question, { type: 'score' }>['levels'][number];
type Answer = CreateDecisionResponse['answers'][number];

// The public service failure union.
export type CreateDecisionFailure = ModelResolutionFailure | ProviderFailure;

/**
 * Instantiate a decision model.
 */
function createModel(info: GetModelResponse, headers: CreateDecisionHeaders): DecisionModel | undefined {
  const config = { apiKey: headers['ai-api-key'], baseURL: headers['ai-base-url'] };

  switch (info.provider) {
    case 'openai':
      return createOpenAI(config).decisionModel(info.name);

    case 'typesafe-ai':
      return createTypeSafeAi(config).decisionModel(info.name);

    default:
      return undefined;
  }
}

/**
 * Transform an OpenAI question into the AI SDK shape.
 *
 * @param question
 * The original OpenAI shaped question object.
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
 */
function toOpenAIAnswer(question: Question, answer: SdkAnswer, confidence: number | undefined): Answer {
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
 * Answers typed questions about one input.
 *
 * @param headers
 * The gateway headers, including the upstream credential.
 *
 * @param body
 * The validated request body.
 */
async function createDecision(
  headers: CreateDecisionHeaders,
  body: CreateDecisionBody,
): Promise<Result<CreateDecisionResponse, CreateDecisionFailure>> {
  const resolved = await resolveModel(body.model, {
    strategy: headers['ai-routing-strategy'],
    weights: headers['ai-routing-weights'],
  });

  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const info = resolved.value;
  const instance = createModel(info, headers);
  if (!instance) {
    return err({ code: 'MODEL_UNSUPPORTED_PROVIDER', model: `${info.provider}/${info.name}`, provider: info.provider });
  }

  //
  const logId = await LogsService.openLog('decision', info, headers['ai-log-tags']);
  const startedAt = performance.now();

  // decide() throws away every answer when any one question is refused, where
  // OpenAI returns the refusal alongside the rest.
  //
  // doDecide() instead of the experimental decide() allows this behavior.
  let result: SdkResult;
  try {
    result = await instance.doDecide({
      state: body.input,
      questions: Object.fromEntries(body.questions.map((question) => [question.name, toSdkQuestion(question)])),
      abortSignal: headers['ai-timeout-ms'] ? AbortSignal.timeout(headers['ai-timeout-ms']) : undefined,
      providerOptions: {
        openai: { safetyIdentifier: body.safety_identifier ?? undefined },
      },
    });
  } catch (error) {
    await LogsService.abandonLog(logId, { request: body, omitRequest: headers['ai-log-omit-request'] });

    const providerFailure = toProviderFailure(error);
    return err(providerFailure);
  }

  const responseTimeMs = performance.now() - startedAt;
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;

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
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  await LogsService.closeLog(logId, {
    request: body,
    response: response,
    omitRequest: headers['ai-log-omit-request'],
    omitResponse: headers['ai-log-omit-response'],
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(info.cost_input != null ? { input_cost: (inputTokens * info.cost_input) / 1_000_000 } : {}),
    response_time_ms: Math.round(responseTimeMs),
  });

  return ok(response);
}

export default {
  createDecision,
};
