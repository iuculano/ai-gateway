import { beforeEach, expect, test } from 'bun:test';
import type { Caller } from '@repo/hono';
// Type-only, so it is erased and cannot load the module ahead of the mocks.
import type { ResolvePromptFailure } from '../../src/api/prompts/prompts.services';
import { callerFixture, database, installModuleMocks, ORGANIZATION_ID, resetDoubles, rows, USER_ID } from './doubles';
import { expectErr, expectOk, type FailureCase } from './result';

await installModuleMocks();

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/prompts/prompts.services');

const PROMPT_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000c';

beforeEach(() => {
  resetDoubles();
  grant('prompts:read');
});

/**
 * Scopes are set on the fixture rather than passed to runWithCaller.
 *
 * doubles.ts replaces getCaller() with one that tries the ambient caller and
 * falls back to callerFixture - but the fallback is what always wins here, so
 * binding a different caller around the call has no effect. Mutating the
 * fixture is the lever that actually works; beforeEach puts it back.
 */
const BASE_SCOPES = [...callerFixture.permissions.scopes];

function grant(...scopes: string[]) {
  callerFixture.permissions = { scopes: [...BASE_SCOPES, ...scopes] };
}

function asCaller<T>(work: () => Promise<T>, caller: Caller = callerFixture): Promise<T> {
  return runWithCaller(caller, work);
}

function promptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMPT_ID,
    organization_id: ORGANIZATION_ID,
    name: 'support-triage',
    description: null,
    active_version: 3,
    tags: {},
    creator_id: USER_ID,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * The version query's PROJECTION, not the row.
 *
 * resolvePrompt selects `{ template: promptVersions.prompt }`, and the database
 * double hands back whatever it was scripted with untouched - it does not apply
 * drizzle's field mapping. So the fixture has to be shaped like the projection
 * or the service reads undefined.
 */
function versionRow(template: string) {
  return { template };
}

// --- the failure matrix ------------------------------------------------------
//
// Five codes, so this earns the `satisfies` table: adding a variant to
// ResolvePromptFailure without a scenario here stops compiling.

const scenarios = {
  PROMPT_FORBIDDEN: {
    run: () => {
      callerFixture.permissions = { scopes: BASE_SCOPES };
      return asCaller(() => Services.resolvePrompt({ name: 'support-triage' }));
    },
  },

  PROMPT_NOT_FOUND: {
    run: () => {
      database.script(rows()); // no prompt by that name in this organization
      return asCaller(() => Services.resolvePrompt({ name: 'support-triage' }));
    },
  },

  PROMPT_NO_ACTIVE_VERSION: {
    run: () => {
      database.script(rows(promptRow({ active_version: null })));
      return asCaller(() => Services.resolvePrompt({ name: 'support-triage' }));
    },
  },

  PROMPT_VERSION_NOT_FOUND: {
    run: () => {
      database.script(rows(promptRow()), rows()); // the prompt exists, v9 does not
      return asCaller(() => Services.resolvePrompt({ name: 'support-triage', version: 9 }));
    },
  },

  PROMPT_VARIABLES_MISSING: {
    run: () => {
      database.script(rows(promptRow()), rows(versionRow('Hello {{ customer_name }}')));
      return asCaller(() => Services.resolvePrompt({ name: 'support-triage' }));
    },
  },
} satisfies Record<
  ResolvePromptFailure['code'],
  FailureCase<{ version: number; prompt: string }, ResolvePromptFailure>
>;

test('resolvePrompt refuses a caller without prompts:read', async () => {
  const failure = expectErr(await scenarios.PROMPT_FORBIDDEN.run());

  expect(failure).toEqual({ code: 'PROMPT_FORBIDDEN', required: 'prompts:read' });
});

test('resolvePrompt returns PROMPT_NOT_FOUND for an unknown name', async () => {
  expect(expectErr(await scenarios.PROMPT_NOT_FOUND.run())).toEqual({
    code: 'PROMPT_NOT_FOUND',
    name: 'support-triage',
  });
});

test('resolvePrompt separates "never versioned" from "no such version"', async () => {
  expect(expectErr(await scenarios.PROMPT_NO_ACTIVE_VERSION.run())).toEqual({
    code: 'PROMPT_NO_ACTIVE_VERSION',
    name: 'support-triage',
  });

  expect(expectErr(await scenarios.PROMPT_VERSION_NOT_FOUND.run())).toEqual({
    code: 'PROMPT_VERSION_NOT_FOUND',
    name: 'support-triage',
    version: 9,
  });
});

// The whole reason inference does not share the preview's renderer policy: an
// unfilled tag here would be sent to the model as literal braces.
test('resolvePrompt refuses rather than sending an unfilled tag to the model', async () => {
  const failure = expectErr(await scenarios.PROMPT_VARIABLES_MISSING.run());

  expect(failure).toEqual({
    code: 'PROMPT_VARIABLES_MISSING',
    name: 'support-triage',
    version: 3,
    missing: ['customer_name'],
  });
});

test('resolvePrompt renders the active version, built-ins included', async () => {
  database.script(
    rows(promptRow()),
    rows(versionRow('{{ aig.prompt_name }} v{{ aig.prompt_version }} for {{ aig.organization_name }}: {{ topic }}')),
  );

  const resolved = expectOk(
    await asCaller(() => Services.resolvePrompt({ name: 'support-triage', variables: { topic: 'billing' } })),
  );

  expect(resolved).toEqual({
    version: 3,
    prompt: 'support-triage v3 for acme: billing',
  });
});

test('resolvePrompt honours a pinned version over the active one', async () => {
  database.script(rows(promptRow({ active_version: 3 })), rows(versionRow('pinned')));

  const resolved = expectOk(await asCaller(() => Services.resolvePrompt({ name: 'support-triage', version: 1 })));

  // The version reported back is the one that was asked for, not the prompt's
  // active pointer - that value is what the ai-prompt-version header echoes.
  expect(resolved.version).toBe(1);
});

// An input whose value looks like a tag must not be rescanned - the property
// that stops a caller reaching a built-in through a variable.
test('resolvePrompt does not rescan substituted values', async () => {
  database.script(rows(promptRow()), rows(versionRow('{{ topic }}')));

  const resolved = expectOk(
    await asCaller(() =>
      Services.resolvePrompt({ name: 'support-triage', variables: { topic: '{{ aig.organization_id }}' } }),
    ),
  );

  expect(resolved.prompt).toBe('{{ aig.organization_id }}');
});
