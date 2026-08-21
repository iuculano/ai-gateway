import { beforeEach, describe, expect, test } from 'bun:test';
import {
  audit,
  callerFixture,
  database,
  installModuleMocks,
  ORGANIZATION_ID,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk } from './result';

/**
 * The prompt CRUD surface.
 *
 * The existing prompts suite covers resolvePrompt - the inference path - and
 * nothing else, which left the fourteen other exported functions untested. The
 * cases below favour the branches a caller can actually reach: a missing row, a
 * name already taken, a page that has more behind it, and the distinction
 * between "no such prompt" and "this prompt has no versions".
 */

await installModuleMocks();

const { runWithCaller } = await import('@repo/hono');
const { default: Services } = await import('../../src/api/prompts/prompts.services');

const PROMPT_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000c';
const OTHER_ID = '01912d3f-9b4a-7c3d-8e2f-00000000000d';

/** Descending ids, so the newest-first ordering is visible in the fixtures. */
const ID_C = '01912d3f-9b4a-7c3d-8e2f-0000000000c3';
const ID_B = '01912d3f-9b4a-7c3d-8e2f-0000000000b2';
const ID_A = '01912d3f-9b4a-7c3d-8e2f-0000000000a1';

beforeEach(() => {
  resetDoubles();
});

function asCaller<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFixture, work);
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

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '01912d3f-9b4a-7c3d-8e2f-0000000000aa',
    prompt_id: PROMPT_ID,
    version: 3,
    prompt: 'Hello there',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('getPrompt', () => {
  test('returns the row', async () => {
    database.script(rows(promptRow()));

    const prompt = expectOk(await asCaller(() => Services.getPrompt(PROMPT_ID)));

    expect(prompt.id).toBe(PROMPT_ID);
    expect(prompt.name).toBe('support-triage');
  });

  test('returns PROMPT_NOT_FOUND as a value rather than throwing', async () => {
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.getPrompt(PROMPT_ID)))).toEqual({
      code: 'PROMPT_NOT_FOUND',
      id: PROMPT_ID,
    });
  });

  test('an id belonging to another organization reads as absent', async () => {
    // The double cannot enforce the predicate, so this asserts the SHAPE of the
    // answer: a cross-tenant id must be indistinguishable from a missing one,
    // never a row and never an error that confirms the id exists.
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.getPrompt(OTHER_ID)))).toEqual({
      code: 'PROMPT_NOT_FOUND',
      id: OTHER_ID,
    });
  });
});

describe('getPromptByName', () => {
  test('resolves within the organization', async () => {
    database.script(rows(promptRow()));

    const prompt = expectOk(await asCaller(() => Services.getPromptByName('support-triage')));
    expect(prompt.name).toBe('support-triage');
  });

  test('reports the name, not an id, when nothing matches', async () => {
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.getPromptByName('nope')))).toEqual({
      code: 'PROMPT_NOT_FOUND',
      name: 'nope',
    });
  });
});

describe('listPrompts', () => {
  test('trims the probe row and reports more data behind it', async () => {
    // Three rows for a limit of two: the third is the probe, and exists only so
    // more_data can be answered without a second count query.
    database.script(rows(promptRow({ id: ID_C }), promptRow({ id: ID_B }), promptRow({ id: ID_A })));

    const page = await asCaller(() => Services.listPrompts({ limit: 2 }));

    expect(page.data).toHaveLength(2);
    expect(page.meta.more_data).toBe(true);
    expect(page.meta.oldest_id).toBe(ID_B);
  });

  test('an exactly full page does not claim more data', async () => {
    database.script(rows(promptRow({ id: ID_C }), promptRow({ id: ID_B })));

    const page = await asCaller(() => Services.listPrompts({ limit: 2 }));

    expect(page.data).toHaveLength(2);
    expect(page.meta.more_data).toBe(false);
  });

  test('an empty result carries a null cursor rather than undefined', async () => {
    database.script(rows());

    const page = await asCaller(() => Services.listPrompts({ limit: 20 }));

    expect(page.data).toEqual([]);
    expect(page.meta).toEqual({ oldest_id: null, more_data: false });
  });

  test('accepts a tag filter and a cursor together', async () => {
    database.script(rows(promptRow()));

    const page = await asCaller(() => Services.listPrompts({ limit: 20, tags: 'env:prod', after_id: OTHER_ID }));

    expect(page.data).toHaveLength(1);
  });
});

describe('createPrompt', () => {
  test('returns the created row and writes one audit entry inside the transaction', async () => {
    database.script(rows(promptRow()));

    const created = expectOk(await asCaller(() => Services.createPrompt({ name: 'support-triage' })));

    expect(created.id).toBe(PROMPT_ID);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.body.event).toBe('prompts.created');
    // Transactional, so a rolled-back create leaves no audit entry claiming it
    // happened.
    expect(audit.calls[0]?.transactional).toBe(true);
  });

  test('a taken name is a refusal, not a crash', async () => {
    // ON CONFLICT DO NOTHING returns no row, which is how losing the race for a
    // name arrives here.
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.createPrompt({ name: 'support-triage' })))).toEqual({
      code: 'PROMPT_NAME_TAKEN',
      name: 'support-triage',
    });
  });

  test('a refused create writes no audit entry', async () => {
    database.script(rows());

    await asCaller(() => Services.createPrompt({ name: 'support-triage' }));

    expect(audit.calls).toHaveLength(0);
  });
});

describe('deletePrompt', () => {
  test('records what was deleted, since the row will not survive to be read', async () => {
    database.script(rows(promptRow()));

    expectOk(await asCaller(() => Services.deletePrompt(PROMPT_ID)));

    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]?.body.event).toBe('prompts.deleted');
    // Stated rather than diffed: the audit entry is the only remaining record.
    expect(audit.calls[0]?.body.metadata).toMatchObject({
      name: 'support-triage',
      active_version: 3,
    });
  });

  test('deleting something absent is a refusal with no audit entry', async () => {
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.deletePrompt(PROMPT_ID)))).toEqual({
      code: 'PROMPT_NOT_FOUND',
      id: PROMPT_ID,
    });
    expect(audit.calls).toHaveLength(0);
  });
});

describe('getPromptVersion', () => {
  test('returns the version through its parent', async () => {
    // The service selects `{ version: promptVersions }`, so the double has to
    // hand back that projection rather than a bare row.
    database.script(rows({ version: versionRow() }));

    const version = expectOk(await asCaller(() => Services.getPromptVersion(PROMPT_ID, 3)));

    expect(version.version).toBe(3);
    expect(version.prompt).toBe('Hello there');
  });

  test('names both the prompt and the ordinal when absent', async () => {
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.getPromptVersion(PROMPT_ID, 9)))).toEqual({
      code: 'PROMPT_VERSION_NOT_FOUND',
      id: PROMPT_ID,
      version: 9,
    });
  });
});

describe('listPromptVersions', () => {
  test('separates an unknown prompt from one with no versions', async () => {
    // Unknown prompt: the parent lookup comes back empty and the listing never
    // runs, so this is a refusal rather than an empty page.
    database.script(rows());

    expect(expectErr(await asCaller(() => Services.listPromptVersions(PROMPT_ID, { limit: 20 })))).toEqual({
      code: 'PROMPT_NOT_FOUND',
      id: PROMPT_ID,
    });

    resetDoubles();

    // Known prompt, no versions yet: an empty page, which is a different answer
    // and the only one of the two worth retrying later.
    database.script(rows(promptRow()), rows());

    const page = expectOk(await asCaller(() => Services.listPromptVersions(PROMPT_ID, { limit: 20 })));
    expect(page.data).toEqual([]);
    expect(page.meta.more_data).toBe(false);
  });

  test('pages newest-first and trims the probe', async () => {
    database.script(
      rows(promptRow()),
      rows(
        { ...versionRow({ id: ID_C, version: 3 }), prompt: undefined },
        { ...versionRow({ id: ID_B, version: 2 }), prompt: undefined },
        { ...versionRow({ id: ID_A, version: 1 }), prompt: undefined },
      ),
    );

    const page = expectOk(await asCaller(() => Services.listPromptVersions(PROMPT_ID, { limit: 2 })));

    expect(page.data).toHaveLength(2);
    expect(page.meta.more_data).toBe(true);
    expect(page.meta.oldest_id).toBe(ID_B);
  });
});
