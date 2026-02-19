import { connect, type NatsConnection } from 'nats';

const servers = process.env.NATS_URL || 'nats://localhost:4222';

export const nats: NatsConnection = await connect({ servers });

export {
  AckPolicy,
  JSONCodec,
  StringCodec,
} from 'nats';
