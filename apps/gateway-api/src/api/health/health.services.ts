import { db } from '../../clients/drizzle';
import { nats } from '../../clients/nats';
import { redis } from '../../clients/redis';


async function checkPostgres(): Promise<boolean> {
  try {
    await db.execute('SELECT 1');
    return true;
  } 
  
  catch {
    return false;
  }
}

async function checkPostgresTables(requiredTables: string[]): Promise<boolean> {
  try {
    requiredTables = requiredTables || [];
    // Assume that the database connection is valid
    const result = await db.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );

    const rows = result.map((row) => row.table_name);
    const allExists = requiredTables.every(table => rows.includes(table));

    return allExists;
  }
  
  catch {
    return requiredTables.length === 0;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  }
  
  catch {
    return false;
  }
}

async function checkNats(): Promise<boolean> {
  try {
    await nats.flush();
    return true;
  }
  
  catch {
    return false;
  }
}

export default {
  checkPostgres,
  checkPostgresTables,
  checkRedis,
  checkNats,
}