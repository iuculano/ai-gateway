/**
 * A JSON tokenizer for the payload panels.
 *
 * Hand-rolled rather than pulled from a highlighting library: the input is
 * always `JSON.stringify(value, null, 2)` output, so the grammar is tiny and
 * already canonically formatted. Shiki or highlight.js would be a megabyte of
 * dependency to colour five token types.
 *
 * It returns TOKENS rather than an HTML string, and that is the load-bearing
 * decision. These payloads are arbitrary model output and user prompts - a
 * prompt containing `<img src=x onerror=...>` is a perfectly ordinary thing to
 * log. Emitting markup for `{@html}` would make that execute in the dashboard
 * of whoever opened the row: stored XSS, delivered by the debugging tool. An
 * array rendered through `{#each}` keeps Svelte's escaping on every value.
 */

export type TokenKind = 'key' | 'string' | 'number' | 'keyword' | 'punctuation';

export interface JsonToken {
  text: string;
  kind: TokenKind;
}

/**
 * Strings (with escapes), numbers, and the three bare literals. Everything
 * between matches - braces, brackets, commas, colons, indentation - is
 * punctuation and is emitted from the gaps.
 *
 * Strings come first so that digits or the word `null` INSIDE one are never
 * matched separately; the scan is left to right, and a string's opening quote
 * always precedes its contents.
 */
const TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;

/**
 * Above this, highlighting is skipped and the raw text is rendered instead.
 *
 * A megabyte payload would otherwise become hundreds of thousands of DOM nodes
 * and lock the tab up while a reader is only trying to see whether the row is
 * the one they wanted.
 */
export const HIGHLIGHT_LIMIT = 200_000;

/**
 * Whether the string ending at `end` is an object key rather than a value.
 *
 * Looks past whitespace for a colon. Checking after the CLOSING quote is what
 * keeps `"http://example.com"` a value rather than a key.
 */
function isKey(json: string, end: number): boolean {
  let index = end;
  while (
    index < json.length &&
    (json[index] === ' ' || json[index] === '\n' || json[index] === '\r' || json[index] === '\t')
  ) {
    index++;
  }

  return json[index] === ':';
}

function kindOf(text: string, json: string, end: number): TokenKind {
  if (text.startsWith('"')) {
    return isKey(json, end) ? 'key' : 'string';
  }

  return text === 'true' || text === 'false' || text === 'null' ? 'keyword' : 'number';
}

/**
 * Splits pretty-printed JSON into coloured spans.
 *
 * @param json
 * The output of JSON.stringify. Malformed input does not throw - anything the
 * pattern does not recognise falls through to the gaps as punctuation, so the
 * worst case is uncoloured text rather than a broken panel.
 */
export function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let cursor = 0;

  // Reset explicitly: the regex is module-level and /g carries lastIndex across
  // calls, which would make every panel after the first start mid-document.
  TOKEN.lastIndex = 0;

  let match = TOKEN.exec(json);
  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({ text: json.slice(cursor, match.index), kind: 'punctuation' });
    }

    const end = match.index + match[0].length;
    tokens.push({ text: match[0], kind: kindOf(match[0], json, end) });
    cursor = end;

    match = TOKEN.exec(json);
  }

  if (cursor < json.length) {
    tokens.push({ text: json.slice(cursor), kind: 'punctuation' });
  }

  return tokens;
}
