import { beforeEach, expect, test } from 'bun:test';
import type { GetLogPayloadResponse } from '../../src/api/logs/logs.schemas';
import type { GetLogPayloadFailure } from '../../src/api/logs/logs.services';
import { database, failsWith, installModuleMocks, LOG_ID, logRow, objects, resetDoubles, rows } from './doubles';
import { expectErr, expectOk, type FailureCase } from './result';

await installModuleMocks();

const { default: Services } = await import('../../src/api/logs/logs.services');

const REQUEST_KEY = `logs/org/${LOG_ID}/request.json.zst`;
const RESPONSE_KEY = `logs/org/${LOG_ID}/response.json.zst`;

beforeEach(() => {
  resetDoubles();
});

// --- the single-code failures ------------------------------------------------
//
// No matrix for these two: the assertNever in each handler mapper is what makes
// a new variant fail to compile, and a plain test says the rest.

test('getLog returns LOG_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await Services.getLog(LOG_ID))).toEqual({ code: 'LOG_NOT_FOUND', id: LOG_ID });
});

test('deleteLog returns LOG_NOT_FOUND as a value', async () => {
  database.script(rows());

  expect(expectErr(await Services.deleteLog(LOG_ID))).toEqual({ code: 'LOG_NOT_FOUND', id: LOG_ID });
});

// --- getLogPayload: one scenario per declared code ---------------------------
//
// Three members, and forgetting a scenario for one is easy - so this union does
// get the matrix. Adding a variant without a case is a type error here.

const payloadFailureCases = {
  LOG_NOT_FOUND: {
    run: () => {
      database.script(rows()); // no such log for this tenant

      return Services.getLogPayload(LOG_ID, 'request');
    },
  },

  PAYLOAD_NOT_STORED: {
    run: () => {
      // The log exists, but nothing was ever written on that side - the caller
      // sent ai-log-omit-request, or the call failed before there was output.
      database.script(rows(logRow({ request_object_reference: null })));

      return Services.getLogPayload(LOG_ID, 'request');
    },
  },

  PAYLOAD_UNAVAILABLE: {
    run: () => {
      // The row still advertises an object that is no longer in the bucket.
      database.script(rows(logRow({ request_object_reference: REQUEST_KEY })));

      return Services.getLogPayload(LOG_ID, 'request');
    },
  },
} satisfies Record<GetLogPayloadFailure['code'], FailureCase<GetLogPayloadResponse, GetLogPayloadFailure>>;

for (const [code, scenario] of Object.entries(payloadFailureCases)) {
  test(`getLogPayload returns ${code} as a value`, async () => {
    const failure = expectErr(await scenario.run());

    expect(failure.code).toBe(code as GetLogPayloadFailure['code']);
  });
}

// --- getLog ------------------------------------------------------------------

test('getLog returns Ok with the derived payload flags', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY, response_object_reference: null })));

  const log = expectOk(await Services.getLog(LOG_ID));

  // Derived from the key columns, which are themselves dropped from the shape.
  expect(log.has_request).toBe(true);
  expect(log.has_response).toBe(false);
  expect(log).not.toHaveProperty('request_object_reference');
  expect(log).not.toHaveProperty('organization_id');

  // numeric arrives as a string and is coerced.
  expect(log.input_cost).toBe(0.001);
});

test('getLog rejects when the query fails', async () => {
  database.script(failsWith(new Error('connection terminated')));

  await expect(Services.getLog(LOG_ID)).rejects.toThrow('connection terminated');
});

// --- getLogPayload -----------------------------------------------------------

test('getLogPayload returns the stored payload', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY })));
  objects.stored[REQUEST_KEY] = { messages: [{ role: 'user', content: 'hello' }] };

  const payload = expectOk(await Services.getLogPayload(LOG_ID, 'request'));

  expect(payload).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
});

test('getLogPayload reads the side it was asked for', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY, response_object_reference: RESPONSE_KEY })));
  objects.stored[REQUEST_KEY] = 'the request';
  objects.stored[RESPONSE_KEY] = 'the response';

  expect(expectOk(await Services.getLogPayload(LOG_ID, 'response'))).toBe('the response');
});

test('the two empty-payload failures carry the side, because the message names it', async () => {
  database.script(rows(logRow({ response_object_reference: null })));

  const failure = expectErr(await Services.getLogPayload(LOG_ID, 'response'));

  expect(failure).toEqual({ code: 'PAYLOAD_NOT_STORED', id: LOG_ID, side: 'response' });
});

test('getLogPayload rejects when object storage fails rather than reporting absence', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY })));

  // A bucket that is unreachable is a malfunction. Reporting it as "no payload"
  // would tell the caller something false about their own data.
  objects.failure = new Error('connection reset by peer');

  await expect(Services.getLogPayload(LOG_ID, 'request')).rejects.toThrow('connection reset by peer');
});

test('a payload stored as null reads back as unavailable', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY })));
  objects.stored[REQUEST_KEY] = null;

  const result = await Services.getLogPayload(LOG_ID, 'request');

  // Documenting a limitation rather than asserting a design: getJson uses null
  // for "no such object", so an object that genuinely holds null is
  // indistinguishable from one that is gone. Nothing writes a bare null today
  // - putJson is only ever handed a request or response body - so this costs
  // nothing, but it is the reason the port cannot answer "stored, and empty".
  expect(expectErr(result).code).toBe('PAYLOAD_UNAVAILABLE');
});

// --- deleteLog ---------------------------------------------------------------

test('deleteLog removes both payloads', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY, response_object_reference: RESPONSE_KEY })));
  objects.stored[REQUEST_KEY] = 'a';
  objects.stored[RESPONSE_KEY] = 'b';

  expect((await Services.deleteLog(LOG_ID)).isOk()).toBe(true);

  expect(objects.deleted).toEqual([[REQUEST_KEY, RESPONSE_KEY]]);
  expect(objects.stored).toEqual({});
});

test('deleteLog skips the sides that were never stored', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY, response_object_reference: null })));

  expect((await Services.deleteLog(LOG_ID)).isOk()).toBe(true);

  // Nulls are filtered out rather than handed to the store as keys.
  expect(objects.deleted).toEqual([[REQUEST_KEY]]);
});

test('deleteLog rejects when object deletion fails, after the row is already gone', async () => {
  database.script(rows(logRow({ request_object_reference: REQUEST_KEY })));
  objects.failure = new Error('bucket unavailable');

  // Deliberate: the row is deleted first, so a failure here leaves orphaned
  // objects. The caller hears about it rather than being told it was clean.
  await expect(Services.deleteLog(LOG_ID)).rejects.toThrow('bucket unavailable');
});

// --- the operations that stay plain promises ---------------------------------

test('getLogPayloadBatch reports absence in the success value, not as a failure', async () => {
  const otherId = '01912d3f-9b4a-7c3d-8e2f-000000000008';

  database.script(
    rows(
      { id: LOG_ID, request_object_reference: REQUEST_KEY, response_object_reference: null },
      { id: otherId, request_object_reference: null, response_object_reference: null },
    ),
  );
  objects.stored[REQUEST_KEY] = 'the request';

  const batch = await Services.getLogPayloadBatch([LOG_ID, otherId], 'request');

  // Deliberately not a Result: a caller asking for two and getting one has not
  // failed at anything.
  expect('isOk' in batch).toBe(false);
  expect(batch.data[LOG_ID]).toBe('the request');
  expect(batch.meta).toEqual({ requested: 2, returned: 1, missing: [otherId] });
});

test('getLogPayloadBatch never turns an unseen id into an object key', async () => {
  const foreignId = '01912d3f-9b4a-7c3d-8e2f-000000000009';

  // The scoped query returns nothing for the foreign id, so it never reaches
  // object storage - which has no idea who is asking and would happily serve it.
  database.script(rows());
  objects.failure = new Error('object storage must not be called');

  const batch = await Services.getLogPayloadBatch([foreignId], 'request');

  expect(batch.meta.missing).toEqual([foreignId]);
  expect(batch.data).toEqual({});
});

test('listLogs stays a plain promise', async () => {
  database.script(rows(logRow()));

  const page = await Services.listLogs({ limit: 50 });

  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
  expect(page.meta).toEqual({ newest_id: LOG_ID, oldest_id: LOG_ID, more_data: false });
});

test('startLog rejects rather than returning a failure', async () => {
  // Ingestion, not a handler - there is no HTTP caller to hand a refusal to.
  database.script(rows());

  await expect(
    Services.startLog('org', { model: 'gpt-4-turbo', provider: 'openai', actor_type: 'api_key', actor_id: 'key-1' }),
  ).rejects.toThrow('Failed to open log');
});

test('completeLog stores both payloads before publishing their references', async () => {
  database.script(rows());

  await Services.completeLog('org', LOG_ID, {
    request: { messages: ['hello'] },
    response: { answer: 'hi' },
    input_tokens: 2,
    output_tokens: 1,
  });

  expect(objects.stored).toEqual({
    [REQUEST_KEY]: { messages: ['hello'] },
    [RESPONSE_KEY]: { answer: 'hi' },
  });
  expect(database.calls.find((call) => call.method === 'set')?.args[0]).toMatchObject({
    status: 'complete',
    request_object_reference: REQUEST_KEY,
    response_object_reference: RESPONSE_KEY,
    input_tokens: 2,
    output_tokens: 1,
  });
});

test('completeLog does not publish object references when storage fails', async () => {
  objects.failure = new Error('bucket unavailable');

  await expect(Services.completeLog('org', LOG_ID, { request: { messages: ['hello'] } })).rejects.toThrow(
    'bucket unavailable',
  );

  expect(database.calls).toHaveLength(0);
});

test('failLog stores the request and marks the row failed', async () => {
  database.script(rows());

  await Services.failLog('org', LOG_ID, { request: { messages: ['hello'] } });

  expect(objects.stored[REQUEST_KEY]).toEqual({ messages: ['hello'] });
  expect(database.calls.find((call) => call.method === 'set')?.args[0]).toMatchObject({
    status: 'failed',
    request_object_reference: REQUEST_KEY,
  });
});
