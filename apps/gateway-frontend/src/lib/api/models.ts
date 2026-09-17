import type { InferRequestType } from 'hono/client';
import { client } from './client';

type ListProvidersRequest = InferRequestType<(typeof client)['models']['providers']['$get']>;
export type ListProvidersQuery = NonNullable<ListProvidersRequest['query']>;

export async function listProviders(query: ListProvidersQuery = {}) {
  const response = await client.models.providers.$get({ query });
  return response.json();
}

/** Loads the full catalog for playground suggestions. */
export async function listAllProviders() {
  let page = await listProviders({ limit: 200 });
  const data = [...page.data];

  while (page.meta.more_data && page.meta.oldest_id) {
    page = await listProviders({ limit: 200, after_id: page.meta.oldest_id });
    data.push(...page.data);
  }

  return { data };
}
