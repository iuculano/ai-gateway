import type { ObjectStorageClient } from './object-storage';

/**
 * How many reads may be in flight at once when reading many objects.
 *
 * Batch reads fan out one request per key. Unbounded, a 250-key batch opens 250
 * sockets at once, which is how a caller-supplied number turns into a
 * self-inflicted denial of service. This caps the fan-out without serialising
 * it - the whole point of the batch read is that the requests overlap.
 */
const DEFAULT_MAX_CONCURRENT_READS = 32;

/**
 * zstd level.
 *
 * 3 is the point on the curve where JSON compresses hard without the write
 * becoming CPU-bound. A 10KB chat payload lands around 150 bytes.
 */
const DEFAULT_COMPRESSION_LEVEL = 3;

export interface CompressedJsonStoreOptions {
  maxConcurrentReads?: number;
  compressionLevel?: number;
}

/**
 * Stores JSON payloads, zstd compressed, over any ObjectStorageClient.
 *
 * Layered over the byte port rather than folded into it so that compression and
 * batching are written once and every backend inherits them.
 */
export class CompressedJsonStore {
  private readonly maxConcurrentReads: number;
  private readonly compressionLevel: number;

  constructor(
    private readonly client: ObjectStorageClient,
    options: CompressedJsonStoreOptions = {},
  ) {
    this.maxConcurrentReads = options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
    this.compressionLevel = options.compressionLevel ?? DEFAULT_COMPRESSION_LEVEL;
  }

  /**
   * Compresses and writes a JSON payload.
   *
   * @param path
   * The object key to write to.
   *
   * @param value
   * Any JSON-serialisable value.
   */
  async putJson(path: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) {
      // JSON.stringify returns undefined for functions, symbols and undefined
      // itself. Writing "undefined" as a body would produce an object that
      // fails to parse on the way back out.
      throw new Error(`Refusing to store a non-JSON-serialisable payload at '${path}'`);
    }

    const compressed = Bun.zstdCompressSync(Buffer.from(json), { level: this.compressionLevel });
    await this.client.write(path, compressed);
  }

  /**
   * Reads and decompresses a JSON payload.
   *
   * @param path
   * The object key to read.
   *
   * @returns
   * The parsed payload, or null if the object does not exist.
   */
  async getJson<T = unknown>(path: string): Promise<T | null> {
    const bytes = await this.client.read(path);
    if (bytes === null) {
      return null;
    }

    const decompressed = Bun.zstdDecompressSync(bytes);
    return JSON.parse(Buffer.from(decompressed).toString('utf8')) as T;
  }

  /**
   * Reads many payloads concurrently.
   *
   * The reads overlap up to maxConcurrentReads, so a batch costs roughly the
   * latency of its slowest object rather than the sum of all of them.
   *
   * A failure on one key does not sink the batch. Object storage is a remote
   * system and one key being unreadable says nothing about the other
   * forty-nine; the caller gets what could be read and can tell which keys are
   * absent from the returned map.
   *
   * @param paths
   * The object keys to read. Duplicates are fetched once.
   *
   * @returns
   * A map of key to payload, containing only the keys that resolved.
   */
  async getManyJson<T = unknown>(paths: string[]): Promise<Map<string, T>> {
    const unique = [...new Set(paths)];
    const results = new Map<string, T>();

    // A shared cursor rather than fixed-size chunks: chunking would make every
    // window wait for its own slowest read before the next one starts, which is
    // the barrier this is trying to avoid. Workers just take the next key.
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        const path = unique[cursor++];
        if (path === undefined) {
          return;
        }

        try {
          const value = await this.getJson<T>(path);
          if (value !== null) {
            results.set(path, value);
          }
        } catch {
          // Left out of the map, which is how the caller learns it is missing.
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.maxConcurrentReads, unique.length) }, () => worker()));

    return results;
  }

  /**
   * Deletes an object, tolerating one that is already gone.
   *
   * @param path
   * The object key to delete.
   */
  async delete(path: string): Promise<void> {
    await this.client.delete(path);
  }

  /**
   * Deletes many objects concurrently.
   *
   * @param paths
   * The object keys to delete.
   */
  async deleteMany(paths: string[]): Promise<void> {
    await Promise.all([...new Set(paths)].map((path) => this.client.delete(path)));
  }
}
