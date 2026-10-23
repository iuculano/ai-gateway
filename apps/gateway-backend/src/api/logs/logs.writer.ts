import { db } from '@repo/drizzle';
import { type LogRow, logs } from '@repo/drizzle/schemas';
import { getLogger } from '@repo/hono';
import { objectStorage } from '@repo/object-storage';

export type PendingLog = Omit<typeof logs.$inferInsert, 'status'> & { id: string; organization_id: string };

const writes = new Set<Promise<void>>();

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
  const objects = Object.entries(payloads).map(([side, value]) => ({
    column: `${side}_object_reference`,
    key: `logs/${row.organization_id}/${id}/${side}.json.zst`,
    value,
  }));

  // Start the background write, grab the promise to track.
  const write = (async () => {
    let stored = true;

    // Try to write the object storage payload first.
    try {
      await Promise.all(objects.map(({ key, value }) => objectStorage.putJson(key, value)));
    } catch (error) {
      stored = false;
      logger.error({ err: error, log_id: id }, 'Failed to store inference log payloads');
    }

    // Then the database write...
    try {
      await db.insert(logs).values({
        ...row,
        ...(stored ? Object.fromEntries(objects.map(({ column, key }) => [column, key])) : {}),
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
