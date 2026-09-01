/**
 * The synthetic workload the seeder draws from.
 *
 * Every value here is made up. Nothing reads it back expecting real pricing -
 * what matters is the SHAPE, because shape is what the read paths are sensitive
 * to and a uniform distribution would flatter them:
 *
 *   - Weights are skewed. Real traffic concentrates on one or two models, so
 *     `where model = 'gpt-4o-mini'` is a low-selectivity filter and
 *     `where model = 'o3'` is a high-selectivity one. Seeding an even split
 *     would make every model filter return count/n and hide the difference.
 *   - Costs are per-token and small, so input_cost/output_cost land in the
 *     numeric(20, 12) range the column is actually declared for. Seeding round
 *     numbers would not exercise the string round-trip that logs.schemas.ts
 *     coerces back.
 */

export interface CatalogueEntry {
  model: string;
  provider: string;

  /** USD per input token. Synthetic. */
  cost_input: number;

  /** USD per output token. Synthetic. */
  cost_output: number;

  /** Relative share of traffic. Arbitrary units - only the ratios matter. */
  weight: number;
}

export const CATALOGUE: CatalogueEntry[] = [
  { model: 'gpt-4o-mini', provider: 'openai', cost_input: 0.00000015, cost_output: 0.0000006, weight: 40 },
  { model: 'gpt-4o', provider: 'openai', cost_input: 0.0000025, cost_output: 0.00001, weight: 18 },
  { model: 'gpt-4.1', provider: 'openai', cost_input: 0.000002, cost_output: 0.000008, weight: 12 },
  { model: 'claude-sonnet-4', provider: 'anthropic', cost_input: 0.000003, cost_output: 0.000015, weight: 12 },
  { model: 'claude-haiku-4-5', provider: 'anthropic', cost_input: 0.0000008, cost_output: 0.000004, weight: 8 },
  { model: 'gpt-4o', provider: 'azure', cost_input: 0.0000025, cost_output: 0.00001, weight: 5 },
  { model: 'gemini-2.5-flash', provider: 'google', cost_input: 0.0000003, cost_output: 0.0000025, weight: 3 },
  { model: 'mistral-large', provider: 'mistral', cost_input: 0.000002, cost_output: 0.000006, weight: 1 },

  // Deliberately rare. This is the "one row in five thousand" model filter -
  // the case where an index either helps enormously or is not being used at all.
  { model: 'o3', provider: 'openai', cost_input: 0.000002, cost_output: 0.000008, weight: 1 },
];

/** The `team` tag values, drawn uniformly. */
export const TEAMS = ['platform', 'search', 'billing', 'growth', 'support', 'research'];

/**
 * The rarest model in the catalogue, which the read scenarios filter on.
 *
 * Derived rather than written down twice: change a weight above and the
 * high-selectivity scenario follows it instead of silently becoming a
 * low-selectivity one.
 */
export function rarestModel(): CatalogueEntry {
  return CATALOGUE.reduce((rarest, entry) => (entry.weight < rarest.weight ? entry : rarest));
}

/** The most common model, for the other end of the selectivity range. */
export function commonestModel(): CatalogueEntry {
  return CATALOGUE.reduce((commonest, entry) => (entry.weight > commonest.weight ? entry : commonest));
}

/**
 * Expands the weights into the pick-list the seeder samples uniformly.
 *
 * Repetition rather than a cumulative distribution, because the sampling
 * happens in SQL: one `floor(random() * n) + 1` against a table is far simpler
 * than a range join, and the list is small enough that the duplication costs
 * nothing.
 */
export function weightedCatalogue(): CatalogueEntry[] {
  return CATALOGUE.flatMap((entry) => Array.from({ length: entry.weight }, () => entry));
}
