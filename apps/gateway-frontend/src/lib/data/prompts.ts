/**
 * Template parsing for the dashboard.
 *
 * The renderer itself is not written again here. A preview calls the render
 * endpoint, so that the text on screen is the text the gateway would send.
 * What this file does is read a template well enough to build a form for it,
 * which means knowing which tags exist and which of them the caller is
 * expected to fill in.
 */

/**
 * Mirrors SUBSTITUTION_PATTERN. Case-sensitive, whitespace inside the braces
 * optional.
 */
const TEMPLATE_PATTERN = /\{\{\s*([A-Za-z0-9._-]+)\s*\}\}/g;

export interface TemplateVariables {
  /**
   * Reserved `aig.*` tags. The backend validates and resolves these.
   */
  builtins: string[];

  /**
   * Tags the caller has to supply values for.
   */
  inputs: string[];
}

/**
 * Reads every tag out of a template once each, in first-appearance order. A
 * tag used three times is one value to supply, not three.
 */
export function extractVariables(template: string): TemplateVariables {
  const builtins: string[] = [];
  const inputs: string[] = [];
  const seen = new Set<string>();

  // matchAll clones the regex internally, so the shared global instance above
  // carries no lastIndex between calls.
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const name = match[1];
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);

    if (name.startsWith('aig.')) {
      builtins.push(name);
    } else {
      inputs.push(name);
    }
  }

  return { builtins: builtins, inputs: inputs };
}

/**
 * Distinct tag keys across every loaded prompt, for the stat strip.
 */
export function tagKeys(records: (Record<string, string> | null | undefined)[]): string[] {
  const keys = records.flatMap((record) => Object.keys(record ?? {}));

  return [...new Set(keys)];
}

export interface TemplateSegment {
  text: string;
  variable: boolean;
}

/**
 * Splits a template into text and tag segments, for highlighted display.
 */
export function segmentTemplate(template: string): TemplateSegment[] {
  // A list, not markup injected into a string. The template is user content,
  // and interpolating it into HTML to colour the braces is how that becomes an
  // injection.
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

/**
 * What was typed for a template's variables, kept for the ones a newly chosen
 * template still asks for.
 */
export function carryValues(inputs: string[], typed: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};

  for (const name of inputs) {
    kept[name] = typed[name] ?? '';
  }

  return kept;
}

/**
 * The variables to send, which are the ones the template asks for that have
 * been filled in.
 */
export function suppliedVariables(inputs: string[], typed: Record<string, string>): Record<string, string> {
  const supplied: Record<string, string> = {};

  // Only what the template asks for. A value left over from a prompt chosen
  // earlier is not something the caller meant to send.
  for (const name of inputs) {
    const value = typed[name] ?? '';

    if (value.length > 0) {
      supplied[name] = value;
    }
  }

  return supplied;
}
