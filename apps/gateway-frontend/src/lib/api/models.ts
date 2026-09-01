import { client } from './client';

/**
 * The whole catalogue, grouped by provider.
 *
 * Unpaginated by design - every figure the table shows for a provider is an
 * aggregate over all of its models, so a page boundary would turn each one into
 * a statement about a page. See listProviders in models.services.ts.
 */
export async function listProviders() {
  const response = await client.providers.$get();
  return response.json();
}
