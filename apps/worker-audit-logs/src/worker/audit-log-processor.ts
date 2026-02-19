import { db, sql } from '@repo/drizzle';
import { AckPolicy, JSONCodec, nats } from '@repo/nats';
import { env } from 'bun';
import { environment } from 'src/environment';


const stream = process.env.NATS_AUDIT_LOG_STREAM || 'audit.logs';
const durable = process.env.NATS_AUDIT_LOG_DURABLE || 'audit.logs';

const jetstream = nats.jetstream();
const jsonCodec = JSONCodec<AuditEvent>();

let consumerReady = false;

interface AuditEvent {
  organizationId: string;
  timestamp: string;
  actor: string;
  method: string;
  route: string;
  status: string;
  requestId: string;
  ip: string;
}

interface AuditMessage {
  ack: () => void;
  nak: () => void;
  term: () => void;
  event: AuditEvent;
}


async function ensureAuditGroup(): Promise<void> {
  if (consumerReady) {
    return;
  }

  const jsm = await nats.jetstreamManager();

  try {
    await jsm.consumers.info(stream, durable);
    consumerReady = true;

    return;
  }

  catch {
    await jsm.consumers.add(stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
    });

    consumerReady = true;
  }
}

// https://github.com/nats-io/nats.deno/blob/main/jetstream.md
async function getMessages(): Promise<AuditMessage[]> {
  const pullConsumer = await jetstream.consumers.get(stream, durable);
  const messages = await pullConsumer.fetch({
    max_messages: environment.WORKER_BATCH_SIZE || 500,
    expires: 5000,
  });

  // Just pull a chunk of messages off the stream.
  const parsedMessages: AuditMessage[] = [];
  for await (const message of messages) {
    parsedMessages.push({
      ack: () => message.ack(),
      nak: () => message.nak(),
      term: () => message.term(),
      event: jsonCodec.decode(message.data),
    });
  }

  return parsedMessages;
}

export async function tickAuditLogProcessor(): Promise<void> {
  await ensureAuditGroup();

  let messages: AuditMessage[] = [];

  try {
    messages = await getMessages();
    if (messages.length === 0) {
      await Bun.sleep(Number(env.WORKER_POLL_INTERVAL) || 5000);
      return;
    }

    await processBatch(messages);
    await ackMessages(messages);
  }

  catch (err) {
    console.error('Error processing audit log batch', err);

    if (messages.length > 0) {
      await nakMessages(messages);
    }
  }
}

async function processBatch(messages: AuditMessage[]): Promise<void> {
  const messagesRaw = messages.map((message) => message.event);
  const payload = JSON.stringify(messagesRaw);

  await db.transaction(async (tx) => {

    // https://trvrm.github.io/efficient-postgres-bulk-inserts-take-2.html
    await tx.execute(sql`
      INSERT INTO audit_logs (organizations_id, timestamp, actor, method, route, status_code, request_id, ip)
      SELECT
        (e->>'organizations_id')::text,
        (e->>'timestamp')::timestamptz,
        (e->>'actor')::text,
        (e->>'method')::text,
        (e->>'route')::text,
        (e->>'status_code')::int,
        (e->>'request_id')::text,
        (e->>'ip')::text
      FROM jsonb_array_elements(${payload}::jsonb) AS t(e);
    `);
  });
}

async function ackMessages(messages: AuditMessage[]): Promise<void> {
  for (const message of messages) {
    message.ack();
  }
}

async function nakMessages(messages: AuditMessage[]): Promise<void> {
  for (const message of messages) {
    message.nak();
  }
}
