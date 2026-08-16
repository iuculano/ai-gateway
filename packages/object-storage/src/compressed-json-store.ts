import type { ObjectStorageClient } from './object-storage';

/**
 * How many reads may be in flight at once when reading many objects.
 */
const DEFAULT_MAX_CONCURRENT_READS = 32;

/**
 * zstd level.
 *
 * 3 seems like a good balance, seems faster than gzip and compresses better.
 * You probably don't want to touch this unless you have a great reason.
 */
const DEFAULT_COMPRESSION_LEVEL = 3;

/**
 * Options for constructing a CompressedJsonStore.
 */
export interface CompressedJsonStoreOptions {
  /** How many reads may be in flight at once when reading many objects. */
  maxConcurrentReads?: number;

  /** Zstandard compression level. */
  compressionLevel?: number;
}

/**
 * Stores JSON payloads, zstd compressed, over any ObjectStorageClient.
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

    if (!Number.isInteger(this.maxConcurrentReads) || this.maxConcurrentReads <= 0) {
      throw new RangeError('maxConcurrentReads must be a positive integer');
    }
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
    const uniquePaths = [...new Set(paths)];
    const results = new Map<string, T>();

    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < uniquePaths.length) {
        const path = uniquePaths[index++];
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

    await Promise.all(Array.from({ length: Math.min(this.maxConcurrentReads, uniquePaths.length) }, () => worker()));

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
