import { beforeEach, expect, test } from 'bun:test';
import type { GetLogPayloadResponse } from '../../src/api/logs/logs.schemas';
import type { GetLogPayloadFailure } from '../../src/api/logs/logs.services';
import {
  database,
  failsWith,
  forCaller,
  installModuleMocks,
  LOG_ID,
  logRow,
  ORGANIZATION_ID,
  objects,
  resetDoubles,
  rows,
  USER_ID,
} from './doubles';
import { expectErr, expectOk, type FailureCase } from './result';

await installModuleMocks();

const RawServices = (await import('../../src/api/logs/logs.services')).default;
const Services = forCaller(RawServices);

const KEY = `logs/${ORGANIZATION_ID}/${LOG_ID}.json.zst`;

beforeEach(() => {
  resetDoubles();
});

// The single-code failures
//
// No matrix for these two: the assertNever in each handler mapper is what makes
// a new variant fail to compile, and a plain test says the rest.

test('getLog returns LOG_NOT_FOUND as a value', async () => {
  database.respondTo('select', 'logs', rows());

  expect(expectErr(await Services.getLog(LOG_ID))).toEqual({ code: 'LOG_NOT_FOUND', id: LOG_ID });
});

test('deleteLog returns LOG_NOT_FOUND as a value', async () => {
  database.respondTo('delete', 'logs', rows());

  expect(expectErr(await Services.deleteLog(LOG_ID))).toEqual({ code: 'LOG_NOT_FOUND', id: LOG_ID });
});

// getLogPayload failure cases
//
// Three members, and forgetting a scenario for one is easy - so this union does
// get the matrix. Adding a variant without a case is a type error here.

const payloadFailureCases = {
  LOG_NOT_FOUND: {
    run: () => {
      database.respondTo('select', 'logs', rows());

      return Services.getLogPayload(LOG_ID, 'request');
    },
  },

  PAYLOAD_NOT_STORED: {
    run: () => {
      // The log exists, but nothing was ever written on that side - the caller
      // sent ai-log-omit-request, or the call failed before there was output.
      database.respondTo('select', 'logs', rows(logRow({ has_request: false })));

      return Services.getLogPayload(LOG_ID, 'request');
    },
  },

  PAYLOAD_UNAVAILABLE: {
    run: () => {
      // The row still advertises an object that is no longer in the bucket.
      database.respondTo('select', 'logs', rows(logRow({ has_request: true })));

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

// getLog

test('getLog returns Ok with the derived payload flags', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_request: true, has_response: false })));

  const log = expectOk(await Services.getLog(LOG_ID));

  // Derived from the key columns, which are themselves dropped from the shape.
  expect(log.has_request).toBe(true);
  expect(log.has_response).toBe(false);
  expect(log).not.toHaveProperty('organization_id');

  // numeric arrives as a string and is coerced.
  expect(log.input_cost).toBe(0.001);
});

test('getLog rejects when the query fails', async () => {
  database.respondTo('select', 'logs', failsWith(new Error('connection terminated')));

  await expect(Services.getLog(LOG_ID)).rejects.toThrow('connection terminated');
});

// getLogPayload

test('getLogPayload returns the stored payload', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_request: true })));
  objects.stored[KEY] = { request: { messages: [{ role: 'user', content: 'hello' }] } };

  const payload = expectOk(await Services.getLogPayload(LOG_ID, 'request'));

  expect(payload).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
});

test('getLogPayload reads the side it was asked for out of the one object', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_request: true, has_response: true })));
  database.respondTo('select', 'logs', rows(logRow({ has_request: true, has_response: true })));
  objects.stored[KEY] = { request: 'the request', response: 'the response' };

  expect(expectOk(await Services.getLogPayload(LOG_ID, 'request'))).toBe('the request');
  expect(expectOk(await Services.getLogPayload(LOG_ID, 'response'))).toBe('the response');
});

test('the two empty-payload failures carry the side, because the message names it', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_response: false })));

  const failure = expectErr(await Services.getLogPayload(LOG_ID, 'response'));

  expect(failure).toEqual({ code: 'PAYLOAD_NOT_STORED', id: LOG_ID, side: 'response' });
});

test('getLogPayload rejects when object storage fails rather than reporting absence', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_request: true })));

  // A bucket that is unreachable is a malfunction. Reporting it as "no payload"
  // would tell the caller something false about their own data.
  objects.failure = new Error('connection reset by peer');

  await expect(Services.getLogPayload(LOG_ID, 'request')).rejects.toThrow('connection reset by peer');
});

test('a payload stored as null reads back as unavailable', async () => {
  database.respondTo('select', 'logs', rows(logRow({ has_request: true })));
  objects.stored[KEY] = null;

  const result = await Services.getLogPayload(LOG_ID, 'request');

  // Documenting a limitation rather than asserting a design: getJson uses null
  // for "no such object", so an object that genuinely holds null is
  // indistinguishable from one that is gone. Nothing writes a bare null today
  // - putJson is only ever handed a request or response body - so this costs
  // nothing, but it is the reason the port cannot answer "stored, and empty".
  expect(expectErr(result).code).toBe('PAYLOAD_UNAVAILABLE');
});

// deleteLog

test('deleteLog removes the payload object once', async () => {
  database.respondTo('delete', 'logs', rows(logRow({ has_request: true, has_response: true })));
  objects.stored[KEY] = { request: 'a', response: 'b' };

  expect((await Services.deleteLog(LOG_ID)).isOk()).toBe(true);

  expect(objects.deleted).toEqual([[KEY]]);
  expect(objects.stored).toEqual({});
});

test('deleteLog deletes nothing when no payload was stored', async () => {
  database.respondTo('delete', 'logs', rows(logRow({ has_request: false, has_response: false })));

  expect((await Services.deleteLog(LOG_ID)).isOk()).toBe(true);
  expect(objects.deleted).toEqual([]);
});

test('deleteLog rejects when object deletion fails, after the row is already gone', async () => {
  database.respondTo('delete', 'logs', rows(logRow({ has_request: true })));
  objects.failure = new Error('bucket unavailable');

  // Deliberate: the row is deleted first, so a failure here leaves orphaned
  // objects. The caller hears about it rather than being told it was clean.
  await expect(Services.deleteLog(LOG_ID)).rejects.toThrow('bucket unavailable');
});

// The operations that stay plain promises

test('getLogPayloadBatch reports absence in the success value, not as a failure', async () => {
  const otherId = '01912d3f-9b4a-7c3d-8e2f-000000000008';

  database.respondTo(
    'select',
    'logs',
    rows(
      { id: LOG_ID, has_request: true, has_response: false },
      { id: otherId, has_request: false, has_response: false },
    ),
  );
  objects.stored[KEY] = { request: 'the request' };

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
  database.respondTo('select', 'logs', rows());
  objects.failure = new Error('object storage must not be called');

  const batch = await Services.getLogPayloadBatch([foreignId], 'request');

  expect(batch.meta.missing).toEqual([foreignId]);
  expect(batch.data).toEqual({});
});

test('listLogs stays a plain promise', async () => {
  database.respondTo('select', 'logs', rows(logRow()));

  const page = await Services.listLogs({ limit: 50 });

  expect('isOk' in page).toBe(false);
  expect(page.data).toHaveLength(1);
  expect(page.meta).toEqual({ newest_id: LOG_ID, oldest_id: LOG_ID, more_data: false });
});

const opened = { operation: 'chat', model: 'gpt-4-turbo', provider: 'openai' } as const;

// From the caller fixture forCaller() binds.
const fromCaller = { organization_id: ORGANIZATION_ID, actor_type: 'user', actor_id: USER_ID } as const;

function insertedLog(): Record<string, unknown> | undefined {
  const values = database.queriesFor('insert', 'logs')[0]?.calls.find((call) => call.method === 'values')?.args[0];
  return [values].flat()[0] as Record<string, unknown> | undefined;
}

test('startLog writes nothing until the log settles', async () => {
  expect((await Services.startLog(opened)).id).toBe(LOG_ID);
  expect(database.queries).toHaveLength(0);
});

test('completeLog stores both payloads, then inserts one complete row', async () => {
  database.respondTo('insert', 'logs', rows());

  const log = await Services.startLog(opened);
  await Services.completeLog(log, {
    request: { messages: ['hello'] },
    response: { answer: 'hi' },
    input_tokens: 2,
    output_tokens: 1,
  });
  await Services.flushLogs();

  expect(objects.stored).toEqual({
    [KEY]: { request: { messages: ['hello'] }, response: { answer: 'hi' } },
  });
  expect(database.queriesFor('insert', 'logs')).toHaveLength(1);
  expect(insertedLog()).toMatchObject({
    ...opened,
    ...fromCaller,
    id: LOG_ID,
    status: 'complete',
    has_request: true,
    has_response: true,
    input_tokens: 2,
    output_tokens: 1,
  });
});

test('completeLog still writes the row, without references, when storage fails', async () => {
  // The row carries the usage and cost; losing the payloads must not lose it.
  database.respondTo('insert', 'logs', rows());
  objects.failure = new Error('bucket unavailable');

  const log = await Services.startLog(opened);
  await Services.completeLog(log, {
    request: { messages: ['hello'] },
    response: { choices: [] },
    input_tokens: 2,
  });
  await Services.flushLogs();

  expect(insertedLog()).toMatchObject({ status: 'complete', input_tokens: 2 });
  expect(insertedLog()).toHaveProperty('has_request', false);
  expect(insertedLog()).toHaveProperty('has_response', false);
});

test('failLog stores the request and inserts one failed row', async () => {
  database.respondTo('insert', 'logs', rows());

  const log = await Services.startLog(opened);
  await Services.failLog(log, { request: { messages: ['hello'] } });
  await Services.flushLogs();

  expect(objects.stored[KEY]).toEqual({ request: { messages: ['hello'] } });
  expect(insertedLog()).toMatchObject({ ...opened, status: 'failed', has_request: true });
});

test('logs that settle together are inserted as one batch', async () => {
  database.defaultResponse('insert', 'logs', rows());

  // Called directly: forCaller would flush after each call, one batch apiece.
  const log = await Services.startLog(opened);
  for (let n = 0; n < 3; n++) {
    RawServices.completeLog(log, { request: {}, response: {}, omitRequest: true, omitResponse: true });
  }
  await Services.flushLogs();

  const inserts = database.queriesFor('insert', 'logs');
  expect(inserts).toHaveLength(1);
  expect(inserts[0]?.calls.find((call) => call.method === 'values')?.args[0]).toHaveLength(3);
});

test('a batch that fails is retried row by row, so a bad row only costs itself', async () => {
  database.respondTo('insert', 'logs', failsWith(new Error('violates check constraint')));
  database.respondTo('insert', 'logs', failsWith(new Error('violates check constraint')));
  database.defaultResponse('insert', 'logs', rows());

  const log = await Services.startLog(opened);
  RawServices.completeLog(log, { request: {}, response: {}, omitRequest: true, omitResponse: true });
  RawServices.failLog(log, { request: {}, omitRequest: true });
  await Services.flushLogs();

  // The batch, then each row alone: the first row fails again, the second lands.
  const inserts = database
    .queriesFor('insert', 'logs')
    .map((query) => query.calls.find((call) => call.method === 'values')?.args[0]);
  expect(inserts).toHaveLength(3);
  expect(inserts[0]).toHaveLength(2);
  expect(inserts[2]).toMatchObject({ status: 'failed' });
});

test('failLog records a call whose caller left as incomplete', async () => {
  database.respondTo('insert', 'logs', rows());

  const log = await Services.startLog(opened);
  await Services.failLog(log, { request: { messages: ['hello'] } }, 'incomplete');
  await Services.flushLogs();

  expect(insertedLog()).toMatchObject({
    ...opened,
    status: 'incomplete',
    has_request: true,
  });
});

test('getLog exposes gateway cache hits', async () => {
  database.respondTo(
    'select',
    'logs',
    rows(logRow({ gateway_cache_hit: true, cached_input_tokens: 25, input_cost: '0', output_cost: '0' })),
  );
  expect(expectOk(await Services.getLog(LOG_ID))).toMatchObject({
    gateway_cache_hit: true,
    cached_input_tokens: 25,
    input_tokens: 100,
    output_tokens: 50,
    input_cost: 0,
    output_cost: 0,
  });
});
