/**
 * The providers the gateway can actually route a request to.
 *
 * The keys are the names this gateway knows a provider by; the values are the
 * same provider's id on models.dev. The two sides holding identical strings
 * today is coincidence, not contract - models.dev calls Bedrock
 * `amazon-bedrock` and Vertex `google-vertex`.
 */
export const PROVIDERS = {
  openai: 'openai',
  azure: 'azure',
} as const;

/** A provider name this gateway can reach. */
export type Provider = keyof typeof PROVIDERS;

/**
 * The providers the catalogue worker ingests - deliberately a SUPERSET of the
 * routable ones.
 *
 * These two were one list until Anthropic and Google were added, on the
 * argument that a provider you can route to should always have prices. That
 * still holds in one direction, and the reverse is now false on purpose: the
 * catalogue is also a price reference, and listing a provider is cheaper than
 * implementing a client for it.
 *
 * The cost is that the catalogue shows models no request can currently reach.
 * That is only honest if it is visible, which is why `routable` travels with
 * every provider the API returns rather than being inferred from presence.
 */
export const CATALOG_PROVIDERS = {
  ...PROVIDERS,
  anthropic: 'anthropic',
  google: 'google',
} as const;

/** A provider name the catalogue carries, routable or not. */
export type CatalogProviderId = keyof typeof CATALOG_PROVIDERS;

/**
 * The models.dev provider ids the catalogue worker ingests.
 *
 * models.dev also publishes `azure-cognitive-services`, `google-vertex` and
 * `google-vertex-anthropic`, all deliberately absent. Each is a different
 * surface for a provider already listed here, with its own credentials and
 * overlapping model ids - ingesting them needs a key that tells them apart.
 */
export const CATALOG_SOURCE_IDS: readonly string[] = Object.values(CATALOG_PROVIDERS);

/**
 * Whether a string names a provider this gateway can route to.
 *
 * @param value
 * The candidate provider name.
 */
export function isProvider(value: string): value is Provider {
  // Object.hasOwn rather than `in`, which walks the prototype chain and would
  // answer true for 'toString'.
  return Object.hasOwn(PROVIDERS, value);
}

/**
 * Whether a string names a provider the catalogue carries.
 *
 * @param value
 * The candidate provider name.
 */
export function isCatalogProvider(value: string): value is CatalogProviderId {
  return Object.hasOwn(CATALOG_PROVIDERS, value);
}
