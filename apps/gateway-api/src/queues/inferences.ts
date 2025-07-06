import { jetstream } from '../clients/nats';


const modelCache = new LRUCache({
  max: 250,
});

async function getModelFromCache(modelId: string): Promise<void> {
  // Check if the model is cached
  const cachedModel = modelCache.get(modelId);
  if (cachedModel) {
    return cachedModel;
  }

  // If not cached, fetch from the database or external service
  // This is a placeholder for actual fetching logic
  const model = await fetchModelFromDatabase(modelId);

  // Store in cache
  modelCache.set(modelId, model);
}


const consumer = await jetstream.consumers.get('gateway-api', 'inference-queue');
const messages = await consumer.consume({ 
    max_messages: 5,
});

for await (const msg of messages) {
  console.log("Got:", msg.data);
  msg.ack();
}
