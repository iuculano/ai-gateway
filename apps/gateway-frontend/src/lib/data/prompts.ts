import { BUILTIN_CATALOGUE, BUILTIN_PREFIX } from 'gateway-backend/prompts/builtins';

/**
 * Template parsing for the dashboard.
 *
 * The renderer itself is NOT reimplemented here - preview calls the render
 * endpoint so the text on screen is the text the gateway would send. What this
 * file does is read a template well enough to build a form for it: which tags
 * exist, and which of them the caller is expected to fill in.
 *
 * The list of built-ins is imported from the backend rather than copied. It was
 * copied at first, with a comment asking whoever changed one to change the
 * other - which is a rule nobody gets to enforce. The catalogue is plain data
 * and carries no resolvers, so importing it pulls in no server code.
 */

/** Mirrors SUBSTITUTION_PATTERN. Case-sensitive, whitespace inside the braces optional. */
const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z0-9._-]+)\s*\}\}/g;

export { BUILTIN_CATALOGUE };

/** Built-ins by name, for looking up a description while rendering the form. */
export const BUILTINS = new Map(BUILTIN_CATALOGUE.map((builtin) => [builtin.name, builtin]));

export interface TemplateVariables {
  /** Recognised `aig.*` tags. Filled by the server; the form shows them read-only. */
  builtins: string[];

  /** Everything else - the tags the caller has to supply values for. */
  inputs: string[];

  /**
   * `aig.*` tags that are not a known built-in.
   *
   * Called out separately because they are almost always a typo, and the
   * reserved prefix means supplying one as an input will not help - the
   * renderer never falls through to `inputs` for them.
   */
  unknownBuiltins: string[];
}

/**
 * Reads every tag out of a template, in first-appearance order.
 *
 * Deduplicated: a tag used three times is one value to supply, not three.
 */
export function extractVariables(template: string): TemplateVariables {
  const builtins: string[] = [];
  const inputs: string[] = [];
  const unknownBuiltins: string[] = [];
  const seen = new Set<string>();

  // matchAll clones the regex internally, so the shared global instance above
  // carries no lastIndex between calls.
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;

    seen.add(name);

    if (!name.startsWith(BUILTIN_PREFIX)) {
      inputs.push(name);
    } else if (BUILTINS.has(name)) {
      builtins.push(name);
    } else {
      unknownBuiltins.push(name);
    }
  }

  return { builtins, inputs, unknownBuiltins };
}

/** Distinct tag keys across every loaded prompt, for the stat strip. */
export function tagKeys(records: (Record<string, string> | null | undefined)[]): string[] {
  const keys = new Set<string>();

  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      keys.add(key);
    }
  }

  return [...keys];
}

/**
 * Splits a template into text and tag segments, for highlighted display.
 *
 * Built as a list rather than by injecting markup into a string: the template
 * is user content, and interpolating it into HTML to colour the braces is how
 * that becomes an injection.
 */
export interface TemplateSegment {
  text: string;
  variable: boolean;
}

export function segmentTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;

  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const start = match.index ?? 0;

    if (start > cursor) {
      segments.push({ text: template.slice(cursor, start), variable: false });
    }

    segments.push({ text: match[0], variable: true });
    cursor = start + match[0].length;
  }

  if (cursor < template.length) {
    segments.push({ text: template.slice(cursor), variable: false });
  }

  return segments;
}
