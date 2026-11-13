import { db } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';

export type PendingLog = Omit<typeof logs.$inferInsert, 'status'> & { id: string; organization_id: string };

export type FinishedLog = PendingLog & { status: LogRow['status'] };

// Payload uploads and INSERTs still in progress, so waitForLogWrites can wait
// for them.
const pendingWrites = new Set<Promise<void>>();

// Calls still waiting on their provider, by log id.
const runningCalls = new Map<string, PendingLog>();

export function markRunning(log: PendingLog): void {
  runningCalls.set(log.id, log);
}

// Rows are inserted in batches: one multi-row INSERT per 100 rows or 250 ms.
const BATCH_ROWS = 100;
const BATCH_MS = 250;

/**
 * The rows waiting for the next INSERT.
 */
interface Batch {
  rows: FinishedLog[];
  timer: Timer;
}

let batch: Batch | null = null;

function queueRow(row: FinishedLog): void {
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

function track(write: Promise<void>): void {
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
}

async function insertRows(rows: FinishedLog[]): Promise<void> {
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

/**
 * Hands a finished call's log off to be saved in the background.
 */
export function submitLog(row: FinishedLog, payloads: { request?: unknown; response?: unknown }): void {
  // Takes the call off the running list. If it was already off, its row has
  // been written, by a shutdown, so writing again would count it twice.
  if (!runningCalls.delete(row.id)) {
    return;
  }

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
 * For shutdown only.
 *
 * Gives calls still running some time to finish before failing them as
 * incomplete.
 *
 * @param graceMs
 * How long to wait for calls still running.
 */
export async function shutdownLogs(graceMs: number): Promise<void> {
  // Just spin for a bit to give running calls some time to finish.
  const deadline = Date.now() + graceMs;
  while (runningCalls.size > 0 && Date.now() < deadline) {
    await Bun.sleep(50);
  }

  // Record whatever is still running as incomplete.
  for (const log of [...runningCalls.values()]) {
    submitLog({ ...log, status: 'incomplete' }, {});
  }

  // Try to wwrite what we have to the database.
  await waitForLogWrites();
}

/**
 * Waits for queued log rows to reach the database.
 *
 * Unlike shutdownLogs, it leaves calls that are still running alone.
 */
export async function waitForLogWrites(): Promise<void> {
  await Promise.all(pendingWrites); // uploads finish and queue their rows
  sendBatch(); // send whatever they queued
  await Promise.all(pendingWrites); // wait for that INSERT
}
