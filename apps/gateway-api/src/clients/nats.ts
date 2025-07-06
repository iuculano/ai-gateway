import { 
  AckPolicy,
  connect, 
  ConnectionOptions,
  JSONCodec,
  Stream,
  StringCodec
} from 'nats';

const options: ConnectionOptions = {
  servers: ['localhost:4222']
};

const nats = await connect(options);
const jsonCodec = JSONCodec();
const stringCodec = StringCodec();

const jetstreamManager = await nats.jetstreamManager();
const jetstream = nats.jetstream();

// Ensure the stream exists
let stream: Stream;

type ConsumerDefinition = {
  name: string,
  subject: string,
}

const consumers: ConsumerDefinition[] = [
  {
    name: 'inference-queue',
    subject: 'gateway.inferences',
  },

  {
    name: 'log-queue',
    subject: 'gateway.logs',
  }
];

for (const consumer of consumers) {
  try {
    await jetstreamManager.consumers.add('gateway-api', {
      durable_name: consumer.name,
      filter_subject: consumer.subject,
      ack_policy: AckPolicy.Explicit
    });
  }

  catch (err) {
    // Already exists, ignore
  }
}


export {
  nats,
  jsonCodec,
  stringCodec,
  jetstreamManager,
  jetstream,
};
