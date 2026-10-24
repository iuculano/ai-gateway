import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';
import LogServices from '../../src/api/logs/logs.services';
import { payloadKey } from '../../src/api/logs/logs.writer';
import { callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

let acme: Tenant;

beforeAll(prepareSuite);

beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('log-payloads');
});

// Ensures a failed assertion cannot leave payload objects behind in the
// dedicated test bucket. resetDatabase reads the references before truncating.
afterEach(resetDatabase);

function asTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithCaller(callerFor(acme), work);
}

test('request and response payloads round-trip through MinIO and are deleted with the log', async () => {
  const request = {
    model: 'integration-model',
    messages: [
      { role: 'system', content: 'Answer concisely.' },
      { role: 'user', content: 'What is object storage?' },
    ],
    metadata: { trace: 'payload-integration', retries: 0 },
  };
  const response = {
    id: 'response-1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Durable blob storage.' } }],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  };

  const pending = await asTenant(async () =>
    LogServices.startLog({ operation: 'chat', model: 'integration-model', provider: 'test-provider' }),
  );
  const id = pending.id;
  await LogServices.completeLog(pending, {
    request,
    response,
    input_tokens: 12,
    output_tokens: 4,
  });
  await LogServices.flushLogs();

  const log = await asTenant(() => LogServices.getLog(id));
  expect(log._unsafeUnwrap()).toMatchObject({ has_request: true, has_response: true, status: 'complete' });

  const storedRequest = await asTenant(() => LogServices.getLogPayload(id, 'request'));
  const storedResponse = await asTenant(() => LogServices.getLogPayload(id, 'response'));
  expect(storedRequest._unsafeUnwrap()).toEqual(request);
  expect(storedResponse._unsafeUnwrap()).toEqual(response);

  const requestBatch = await asTenant(() => LogServices.getLogPayloadBatch([id], 'request'));
  const responseBatch = await asTenant(() => LogServices.getLogPayloadBatch([id], 'response'));
  expect(requestBatch).toEqual({ data: { [id]: request }, meta: { requested: 1, returned: 1, missing: [] } });
  expect(responseBatch).toEqual({ data: { [id]: response }, meta: { requested: 1, returned: 1, missing: [] } });

  const key = payloadKey(acme.organizationId, id);
  expect(await objectStorage.getJson<object>(key)).toEqual({ request, response });

  const deleted = await asTenant(() => LogServices.deleteLog(id));
  expect(deleted.isOk()).toBe(true);
  expect(await objectStorage.getJson(key)).toBeNull();
});

test('payload omission leaves the skipped side undiscoverable and unstored', async () => {
  const pending = await asTenant(async () =>
    LogServices.startLog({ operation: 'chat', model: 'integration-model', provider: 'test-provider' }),
  );
  const id = pending.id;
  await LogServices.completeLog(pending, {
    request: { secret: 'do not retain' },
    response: { retained: true },
    omitRequest: true,
  });
  await LogServices.flushLogs();

  const log = (await asTenant(() => LogServices.getLog(id)))._unsafeUnwrap();
  expect(log).toMatchObject({ status: 'complete', has_request: false, has_response: true });

  const request = await asTenant(() => LogServices.getLogPayload(id, 'request'));
  expect(request._unsafeUnwrapErr()).toEqual({ code: 'PAYLOAD_NOT_STORED', id, side: 'request' });
  expect((await asTenant(() => LogServices.getLogPayload(id, 'response')))._unsafeUnwrap()).toEqual({
    retained: true,
  });
});

test('a failed inference retains its request but never advertises a response', async () => {
  const request = { model: 'integration-model', messages: [{ role: 'user', content: 'fail' }] };
  const pending = await asTenant(async () =>
    LogServices.startLog({ operation: 'chat', model: 'integration-model', provider: 'test-provider' }),
  );
  const id = pending.id;

  await LogServices.failLog(pending, { request });

  await LogServices.flushLogs();

  const log = (await asTenant(() => LogServices.getLog(id)))._unsafeUnwrap();
  expect(log).toMatchObject({ status: 'failed', has_request: true, has_response: false });
  expect((await asTenant(() => LogServices.getLogPayload(id, 'request')))._unsafeUnwrap()).toEqual(request);
  expect((await asTenant(() => LogServices.getLogPayload(id, 'response')))._unsafeUnwrapErr()).toEqual({
    code: 'PAYLOAD_NOT_STORED',
    id,
    side: 'response',
  });
});

test('a batch returns healthy payloads when another referenced object is missing', async () => {
  const firstLog = await asTenant(async () =>
    LogServices.startLog({ operation: 'chat', model: 'one', provider: 'test-provider' }),
  );
  const first = firstLog.id;
  const secondLog = await asTenant(async () =>
    LogServices.startLog({ operation: 'chat', model: 'two', provider: 'test-provider' }),
  );
  const second = secondLog.id;
  await LogServices.completeLog(firstLog, {
    request: { value: 'one' },
    response: {},
    omitResponse: true,
  });
  await LogServices.completeLog(secondLog, {
    request: { value: 'two' },
    response: {},
    omitResponse: true,
  });
  await LogServices.flushLogs();

  await objectStorage.delete(payloadKey(acme.organizationId, second));

  const batch = await asTenant(() => LogServices.getLogPayloadBatch([first, second], 'request'));

  expect(batch.data).toEqual({ [first]: { value: 'one' } });
  expect(batch.meta).toEqual({ requested: 2, returned: 1, missing: [second] });
});
