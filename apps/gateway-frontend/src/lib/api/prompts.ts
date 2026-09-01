import type { InferRequestType } from 'hono/client';
import { client } from './client';

type PromptsClient = (typeof client)['prompts'];
type PromptClient = PromptsClient[':id'];
type VersionsClient = PromptClient['versions'];
type VersionClient = VersionsClient[':version'];

export type CreatePromptInput = InferRequestType<PromptsClient['$post']>['json'];
export type UpdatePromptInput = InferRequestType<PromptClient['$patch']>['json'];
export type CreatePromptVersionInput = InferRequestType<VersionsClient['$post']>['json'];
export type UpdatePromptVersionInput = InferRequestType<VersionClient['$patch']>['json'];

export type ListPromptsQuery = NonNullable<InferRequestType<PromptsClient['$get']>['query']>;
export type ListPromptVersionsQuery = NonNullable<InferRequestType<VersionsClient['$get']>['query']>;

export async function listPrompts(query: ListPromptsQuery = {}) {
  const response = await client.prompts.$get({ query });
  return response.json();
}

export async function getPrompt(id: string) {
  const response = await client.prompts[':id'].$get({ param: { id } });
  return response.json();
}

export async function createPrompt(input: CreatePromptInput) {
  const response = await client.prompts.$post({ json: input });
  return response.json();
}

export async function updatePrompt(id: string, input: UpdatePromptInput) {
  const response = await client.prompts[':id'].$patch({ param: { id }, json: input });
  return response.json();
}

export async function deletePrompt(id: string): Promise<void> {
  await client.prompts[':id'].$delete({ param: { id } });
}

/**
 * A prompt's versions, newest first.
 *
 * The rows carry no `prompt` text - the API omits it from the listing so a page
 * of versions is not a page of full prompt bodies. Use getPromptVersion for the
 * text of the one version being read.
 */
export async function listPromptVersions(id: string, query: ListPromptVersionsQuery = {}) {
  const response = await client.prompts[':id'].versions.$get({ param: { id }, query });
  return response.json();
}

/** One version, with its template text. */
export async function getPromptVersion(id: string, version: number) {
  const response = await client.prompts[':id'].versions[':version'].$get({
    param: { id, version: String(version) },
  });

  return response.json();
}

export async function createPromptVersion(id: string, input: CreatePromptVersionInput) {
  const response = await client.prompts[':id'].versions.$post({ param: { id }, json: input });
  return response.json();
}

export async function updatePromptVersion(id: string, version: number, input: UpdatePromptVersionInput) {
  const response = await client.prompts[':id'].versions[':version'].$patch({
    param: { id, version: String(version) },
    json: input,
  });

  return response.json();
}

export async function deletePromptVersion(id: string, version: number): Promise<void> {
  await client.prompts[':id'].versions[':version'].$delete({
    param: { id, version: String(version) },
  });
}

/**
 * Renders a version server-side and returns the result.
 *
 * Deliberately not rendered in the browser. The substitution rules - which
 * built-ins exist, that they outrank supplied inputs, what counts as a tag -
 * live in the service, and a second implementation here would be free to
 * disagree with the text the gateway actually sends.
 */
export async function renderPromptVersion(id: string, version: number, inputs: Record<string, string>) {
  const response = await client.prompts[':id'].versions[':version'].render.$post({
    param: { id, version: String(version) },
    json: { inputs },
  });

  return response.json();
}
