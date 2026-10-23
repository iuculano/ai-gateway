import { db } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';

export type PendingLog = Omit<typeof logs.$inferInsert, 'status'> & { id: string; organization_id: string };

const writes = new Set<Promise<void>>();

export function payloadKey(organizationId: string, id: string): string {
  return `logs/${organizationId}/${id}.json.zst`;
}

/**
 * Writes a log in the background.
 *
 * @param row
 * The row to log.
 *
 * @param payloads
 * Request and response for object storage.
 */
export function settleLog(
  row: PendingLog & { status: LogRow['status'] },
  payloads: { request?: unknown; response?: unknown },
): void {
  // Don't fail the request if the background write fails, just log errors.
  const logger = getLogger();

  const id = row.id;
  const key = payloadKey(row.organization_id, id);
  const sides = Object.keys(payloads);

  // Start the background write, grab the promise to track.
  const write = (async () => {
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

    // Then the database write...
    try {
      await db.insert(logs).values({
        ...row,
        // Flag the sides that made it to storage; both stay false if the upload failed.
        ...(stored ? Object.fromEntries(sides.map((side) => [`has_${side}`, true])) : {}),
      });
    } catch (error) {
      logger.error({ err: error, log_id: id }, 'Failed to write inference log');
    }
  })();

  // Track this write until it finishes, so flushLogs() can wait for it.
  writes.add(write);
  write.finally(() => writes.delete(write));
}

/**
 * Waits for every log write in flight. That's literally it. Mostly for
 * shutdown.
 */
export async function flushLogs(): Promise<void> {
  await Promise.all(writes);
}
