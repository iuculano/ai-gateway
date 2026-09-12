import type { InferRequestType } from 'hono/client';
import { client } from './client';

type ApiKeysClient = (typeof client)['api-keys'];
type ApiKeyClient = ApiKeysClient[':id'];

export type CreateApiKeyInput = InferRequestType<ApiKeysClient['$post']>['json'];
export type UpdateApiKeyInput = InferRequestType<ApiKeyClient['$patch']>['json'];

export async function listApiKeys(
  status: 'all' | 'active' | 'expired' | 'revoked' = 'all',
  query: { limit?: number; after_id?: string } = {},
) {
  const response = await client['api-keys'].$get({ query: { status, ...query } });
  return response.json();
}

export type ApiKeyStatus = 'all' | 'active' | 'expired' | 'revoked';
export async function countApiKeys(status: ApiKeyStatus = 'all') {
  const response = await client['api-keys'].count.$get({ query: { status } });
  return response.json();
}

export async function createApiKey(input: CreateApiKeyInput) {
  const response = await client['api-keys'].$post({ json: input });
  return response.json();
}

export async function updateApiKey(id: string, input: UpdateApiKeyInput) {
  const response = await client['api-keys'][':id'].$patch({ param: { id }, json: input });
  return response.json();
}

export async function revokeApiKey(id: string): Promise<void> {
  await client['api-keys'][':id'].$delete({ param: { id } });
}

/**
 * Usage counters for one key.
 *
 * Separate request because the figures come from redis rather than the primary
 * database - the list endpoint cannot serve them without a per-row round trip.
 */
export async function getApiKeyStats(id: string) {
  const response = await client['api-keys'][':id'].stats.$get({ param: { id } });
  return response.json();
}
