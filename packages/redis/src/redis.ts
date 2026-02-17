import { createClient } from 'redis';

export const redis = await createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  password: process.env.REDIS_PASSWORD,
  username: process.env.REDIS_USERNAME,
  database: process.env.REDIS_DB ? Number.parseInt(process.env.REDIS_DB, 10) : undefined,
})
.on('error', (err: unknown) => console.log('Redis Client Error', err))
.connect();
