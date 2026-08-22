import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { tickWebhookProcessor } from '../../src/worker/webhook-processor';
import { admin, prepareSuite, resetDatabase } from './setup';

const received: unknown[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  await prepareSuite();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push(await request.json());
      return new Response(null, { status: 202 });
    },
  });
});

beforeEach(async () => {
  received.length = 0;
  await resetDatabase();
});

afterAll(async () => {
  server.stop(true);
  await resetDatabase();
  await admin.close();
});

async function seedDelivery(endpoint: string) {
  const [organization] = await admin`
    insert into organizations (external_id, external_idp, name, slug)
    values ('webhook-worker-test', 'test-idp', 'Webhook Worker Test', 'webhook-worker-test')
    returning id
  `;
  if (!organization) {
    throw new Error('Failed to seed the webhook worker integration test');
  }

  const [webhook] = await admin`
    insert into webhooks (organization_id, name, endpoint)
    values (${organization.id}, 'deploys', ${endpoint})
    returning id
  `;
  if (!webhook) {
    throw new Error('Failed to seed a webhook');
  }

  const [outbox] = await admin`
    insert into webhook_outbox (webhook_id, log_id)
    values (${webhook.id}, uuidv7())
    returning id, log_id
  `;
  if (!outbox) {
    throw new Error('Failed to seed an outbox row');
  }

  return { webhookId: webhook.id as string, outboxId: outbox.id as string, logId: outbox.log_id as string };
}

test('claims the outbox row, posts its identifiers, and records the response', async () => {
  const seeded = await seedDelivery(server.url.toString());

  await tickWebhookProcessor();

  expect(received).toEqual([{ webhook_id: seeded.webhookId, log_id: seeded.logId }]);
  expect(await admin`select * from webhook_outbox`).toHaveLength(0);
  const attempts = (await admin`
    select outbox_id, webhook_id, status_code from webhook_deliveries
  `) as unknown as { outbox_id: string; webhook_id: string; status_code: number }[];
  expect(attempts).toEqual([{ outbox_id: seeded.outboxId, webhook_id: seeded.webhookId, status_code: 202 }]);
});

test('records status zero and still removes the outbox row when no response exists', async () => {
  const seeded = await seedDelivery('http://127.0.0.1:1/unreachable');

  await tickWebhookProcessor();

  expect(await admin`select * from webhook_outbox`).toHaveLength(0);
  const attempts = (await admin`
    select outbox_id, status_code from webhook_deliveries
  `) as unknown as { outbox_id: string; status_code: number }[];
  expect(attempts).toEqual([{ outbox_id: seeded.outboxId, status_code: 0 }]);
});
