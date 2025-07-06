import { jetstream } from '../clients/nats';


const consumer = await jetstream.consumers.get('gateway-api', 'logs-worker');
const messages = await consumer.consume({ 
    max_messages: 5,
});

for await (const msg of messages) {
  console.log("Got:", msg.data);
  msg.ack();
}
