import type { GuardrailRow } from '@repo/drizzle/schemas';
import { LRUCache } from 'lru-cache';
import type { EvaluationResult, RegexConfig } from './guardrails.schemas';

/**
 * Matches reported per guardrail, per side.
 *
 * A pattern like `\w` matches thousands of times in an ordinary prompt, and the
 * caller learns nothing from the ten-thousandth occurrence that the first
 * hundred did not already tell them. The cap is on the response, not on the
 * verdict - a guardrail that matched once has failed regardless.
 */
const MAX_MATCHES = 100;

/** Longest matched substring echoed back, so one greedy match cannot carry the whole prompt. */
const MAX_MATCH_LENGTH = 200;

/**
 * Compiled patterns.
 *
 * Keyed by the pattern text and flags rather than by guardrail id, so an edited
 * guardrail cannot be served a stale RegExp - a changed pattern is simply a
 * different key, and the old entry ages out on its own.
 */
const patternCache = new LRUCache<string, RegExp>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour
});

/**
 * Compiles a regex guardrail's pattern.
 *
 * `g` is added here rather than accepted from the caller. matchAll() requires
 * it, and a caller-supplied `g` would ride on a cached RegExp whose lastIndex
 * then leaks between requests. matchAll() itself clones the regex before
 * iterating, so the cached instance stays at lastIndex 0 and is safe to share.
 *
 * @param config
 * The guardrail's validated config.
 *
 * @returns
 * A compiled, globally-flagged RegExp.
 */
export function compile(config: RegexConfig): RegExp {
  const flags = `${config.flags ?? ''}g`;

  // Separated, because concatenating them straight would let `{flags: 'i',
  // pattern: 'x'}` and `{flags: '', pattern: 'ix'}` share a key. A slash is
  // unambiguous here: flags are drawn from [imsug], so the first one is always
  // the boundary however many the pattern goes on to contain.
  const key = `${flags}/${config.pattern}`;

  const cached = patternCache.get(key);
  if (cached) {
    return cached;
  }

  // Cannot throw in practice - regexConfig compiled this exact pair before the
  // row was written - but a row inserted outside the API boundary has never
  // been checked, so the caller treats a throw as a failed guardrail rather
  // than letting it escape as a 500.
  const compiled = new RegExp(config.pattern, flags);
  patternCache.set(key, compiled);

  return compiled;
}

/**
 * Runs one pattern over one string.
 *
 * @param config
 * The guardrail's validated config.
 *
 * @param content
 * The text to scan.
 *
 * @returns
 * Up to MAX_MATCHES matches, in order of appearance.
 */
export function findMatches(config: RegexConfig, content: string): EvaluationResult['matches'] {
  const matches: EvaluationResult['matches'] = [];

  // matchAll advances past a zero-width match on its own, so an anchor-only
  // pattern like `^` terminates rather than spinning.
  for (const match of content.matchAll(compile(config))) {
    if (matches.length >= MAX_MATCHES) {
      break;
    }

    matches.push({
      value: match[0].slice(0, MAX_MATCH_LENGTH),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return matches;
}

/**
 * The concrete sides a guardrail's `target` expands to.
 *
 * 'both' becomes two independent checks rather than one pass over the two
 * strings joined, which would let a pattern match across the seam and report a
 * violation that exists in neither side.
 */
export function sidesFor(target: GuardrailRow['target']): Array<'request' | 'response'> {
  return target === 'both' ? ['request', 'response'] : [target];
}
