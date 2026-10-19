import type { SelectedOffering } from './catalog-sync';

/**
 * Catalog rows models.dev does not have, merged into every snapshot.
 *
 * Acts as an overlay - this can be used to add or override offerings that are
 * not present in the main catalog.
 *
 * For example, models.dev currently has iffy coverage of decision models.
 */
export const CATALOG_OVERLAY: SelectedOffering[] = [
  {
    provider: 'openai',
    type: 'decision',
    // The Decisions API bills input tokens only.
    offering: { id: 'gpt-6-luna', name: 'GPT-6 Luna', cost: { input: 0.1, output: 0 } },
  },
];
