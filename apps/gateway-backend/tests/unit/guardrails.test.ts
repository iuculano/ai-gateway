import { expect, test } from 'bun:test';
import { compile, findMatches, sidesFor } from '../../src/api/guardrails/guardrails.evaluation';
import { regexConfig } from '../../src/api/guardrails/guardrails.schemas';

// Config validation
//
// This is the whole of the shape checking for a jsonb column, so what it lets
// through is what the database ends up holding.

test('accepts a valid pattern', () => {
  expect(regexConfig.safeParse({ pattern: '\\d{3}-\\d{2}-\\d{4}' }).success).toBe(true);
});

test('rejects a pattern that does not compile', () => {
  expect(regexConfig.safeParse({ pattern: '(unclosed' }).success).toBe(false);
});

test('rejects a pattern that is only invalid under its own flags', () => {
  // Legal without `u`, illegal with it - which is why the pair is validated
  // together rather than the pattern alone.
  expect(regexConfig.safeParse({ pattern: '\\-' }).success).toBe(true);
  expect(regexConfig.safeParse({ pattern: '\\-', flags: 'u' }).success).toBe(false);
});

test('rejects the stateful flags', () => {
  expect(regexConfig.safeParse({ pattern: 'a', flags: 'g' }).success).toBe(false);
  expect(regexConfig.safeParse({ pattern: 'a', flags: 'y' }).success).toBe(false);
  expect(regexConfig.safeParse({ pattern: 'a', flags: 'imsu' }).success).toBe(true);
});

test('rejects an empty pattern', () => {
  // An empty pattern matches everywhere, so it would fail every request.
  expect(regexConfig.safeParse({ pattern: '' }).success).toBe(false);
});

// Compilation

test('compiles with g so matchAll can iterate, whatever the caller asked for', () => {
  expect(compile({ pattern: 'a' }).flags).toBe('g');
  expect(compile({ pattern: 'a', flags: 'i' }).flags).toContain('i');
  expect(compile({ pattern: 'a', flags: 'i' }).flags).toContain('g');
});

test('caches by pattern and flags, not by identity', () => {
  expect(compile({ pattern: 'cached' })).toBe(compile({ pattern: 'cached' }));

  // Different flags must not collide onto one entry.
  expect(compile({ pattern: 'x', flags: 'i' })).not.toBe(compile({ pattern: 'x' }));

  // The separator earns its keep here: without it both keys would be "gix".
  expect(compile({ pattern: 'x', flags: 'i' })).not.toBe(compile({ pattern: 'ix' }));
});

test('a cached pattern gives the same answer every time it is used', () => {
  // The reason `g` is never accepted from the caller: a shared RegExp carrying
  // lastIndex would match on one call and miss on the next.
  const config = { pattern: 'secret' };
  const content = 'secret secret';

  expect(findMatches(config, content)).toHaveLength(2);
  expect(findMatches(config, content)).toHaveLength(2);
  expect(findMatches(config, content)).toHaveLength(2);
});

// Matching

test('reports each match with its offsets', () => {
  const matches = findMatches({ pattern: '\\d{3}-\\d{2}-\\d{4}' }, 'my ssn is 123-45-6789 ok');

  expect(matches).toEqual([{ value: '123-45-6789', start: 10, end: 21 }]);
});

test('honours flags', () => {
  expect(findMatches({ pattern: 'SECRET' }, 'secret')).toHaveLength(0);
  expect(findMatches({ pattern: 'SECRET', flags: 'i' }, 'secret')).toHaveLength(1);
});

test('finds nothing in content that does not match', () => {
  expect(findMatches({ pattern: 'nope' }, 'clean content')).toEqual([]);
});

test('terminates on a zero-width pattern', () => {
  // `^` with m matches at every line start and consumes nothing; a hand-rolled
  // exec loop would spin here forever.
  const matches = findMatches({ pattern: '^', flags: 'm' }, 'a\nb\nc');

  expect(matches).toHaveLength(3);
  expect(matches.every((match) => match.start === match.end)).toBe(true);
});

test('caps the number of matches reported', () => {
  const matches = findMatches({ pattern: 'a' }, 'a'.repeat(5000));

  expect(matches).toHaveLength(100);
});

test('truncates an individual match', () => {
  const matches = findMatches({ pattern: '.+' }, 'x'.repeat(5000));

  expect(matches[0]?.value).toHaveLength(200);

  // Truncation is cosmetic - the offsets still describe the real match, so a
  // caller can go back to its own content and find the whole thing.
  expect(matches[0]?.end).toBe(5000);
});

// Targets

test('expands both into two independent sides', () => {
  expect(sidesFor('request')).toEqual(['request']);
  expect(sidesFor('response')).toEqual(['response']);
  expect(sidesFor('both')).toEqual(['request', 'response']);
});
