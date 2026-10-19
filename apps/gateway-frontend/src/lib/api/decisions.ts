import type { InferRequestType, InferResponseType } from 'hono/client';
import { client } from './client';

type CreateDecision = (typeof client)['decisions']['$post'];
type CreateDecisionRequest = InferRequestType<CreateDecision>;

export type DecisionHeaders = CreateDecisionRequest['header'];
export type DecisionRequest = CreateDecisionRequest['json'];
export type DecisionQuestion = DecisionRequest['questions'][number];
export type Decision = InferResponseType<CreateDecision>;
export type DecisionAnswer = Decision['answers'][number];

/**
 * Answers typed questions about one input.
 *
 * @param headers
 * The gateway's `ai-*` controls, including the upstream credential.
 *
 * @param body
 * The request.
 *
 * @param signal
 * Aborts the request.
 */
export async function createDecision(headers: DecisionHeaders, body: DecisionRequest, signal?: AbortSignal) {
  const response = await client.decisions.$post({ header: headers, json: body }, { init: { signal: signal } });

  return response.json();
}
