import { db } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';

export type PendingLog = Omit<typeof logs.$inferInsert, 'status'> & { id: string; organization_id: string };

type SettledLog = PendingLog & { status: LogRow['status'] };

const writes = new Set<Promise<void>>();

// Rows are inserted in batches: one multi-row INSERT per 100 rows or 250 ms.
const BATCH_ROWS = 100;
const BATCH_MS = 250;

/**
 * The rows waiting for the next INSERT.
 */
interface Batch {
  rows: SettledLog[];
  timer: Timer;
}

let batch: Batch | null = null;

function queueRow(row: SettledLog): void {
  // Start a new batch if none exists.
  batch ??= {
    rows: [],
    timer: setTimeout(sendBatch, BATCH_MS), // each batch gets a timer
  };

  batch.rows.push(row);
  if (batch.rows.length >= BATCH_ROWS) {
    sendBatch();
  }
}

function sendBatch(): void {
  // Check if there's even work to do.
  if (!batch) {
    return;
  }

  const { rows, timer } = batch;
  batch = null;
  clearTimeout(timer);
  track(insertRows(rows));
}

/** Holds onto a background write until it finishes, so flushLogs() can wait for it. */
function track(write: Promise<void>): void {
  writes.add(write);
  write.finally(() => writes.delete(write));
}

async function insertRows(rows: SettledLog[]): Promise<void> {
  try {
    // Try to insert all rows in a single batch first.
    await db.insert(logs).values(rows);
  } catch {
    // See if we can try to mitigate the blast radius by retrying each row
    // individually instead of failing the entire batch.
    for (const row of rows) {
      try {
        await db.insert(logs).values(row);
      } catch (error) {
        getLogger().error({ err: error, log_id: row.id }, 'Failed to write inference log');
      }
    }
  }
}

export function payloadKey(organizationId: string, id: string): string {
  return `logs/${organizationId}/${id}.json.zst`;
}

export function settleLog(row: SettledLog, payloads: { request?: unknown; response?: unknown }): void {
  // Don't fail the request if the background write fails, just log errors.
  const logger = getLogger();
  const id = row.id;
  const key = payloadKey(row.organization_id, id);
  const sides = Object.keys(payloads);

  // Start the background write, grab the promise to track.
  const write = (async () => {
    // Track if we've actually written something to object storage.
    let stored = true;

    // Try to write the object storage payload first.
    try {
      if (sides.length > 0) {
        await objectStorage.putJson(key, payloads);
      }
    } catch (error) {
      stored = false;
      logger.error({ err: error, log_id: id }, 'Failed to store inference log payloads');
    }

    // Queue the row for insertion into the database.
    queueRow({
      ...row,
      has_request: stored && 'request' in payloads,
      has_response: stored && 'response' in payloads,
    });
  })();

  track(write);
}

/**
 * Waits for every log write in flight. That's literally it.
 *
 * Mostly for shutdown.
 */
export async function flushLogs(): Promise<void> {
  await Promise.all(writes); // uploads finish and queue their rows
  sendBatch(); // send whatever they queued
  await Promise.all(writes); // wait for that INSERT
}
