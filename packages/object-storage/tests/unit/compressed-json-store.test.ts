import { describe, expect, test } from 'bun:test';
import { CompressedJsonStore, createObjectStorage, type ObjectStorageClient, objectStorage } from '../../index';

class MemoryObjectStorageClient implements ObjectStorageClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly readCounts = new Map<string, number>();
  readonly deleteCalls: string[] = [];
  readonly failedReads = new Set<string>();
  readonly failedDeletes = new Set<string>();

  readDelayMs = 0;
  activeReads = 0;
  maximumActiveReads = 0;

  async read(path: string): Promise<Uint8Array | null> {
    this.readCounts.set(path, (this.readCounts.get(path) ?? 0) + 1);
    this.activeReads += 1;
    this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);

    try {
      if (this.readDelayMs > 0) {
        await Bun.sleep(this.readDelayMs);
      }

      if (this.failedReads.has(path)) {
        throw new Error(`read failed: ${path}`);
      }

      return this.objects.get(path)?.slice() ?? null;
    } finally {
      this.activeReads -= 1;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.objects.set(path, data.slice());
  }

  async delete(path: string): Promise<void> {
    this.deleteCalls.push(path);
    if (this.failedDeletes.has(path)) {
      throw new Error(`delete failed: ${path}`);
    }

    this.objects.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.objects.has(path);
  }
}

describe('CompressedJsonStore', () => {
  test('round-trips JSON through zstd-compressed bytes', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client);
    const value = {
      message: 'hello 🌍',
      nested: { enabled: true },
      values: [1, null, 'three'],
    };

    await store.putJson('payload.json.zst', value);

    const bytes = client.objects.get('payload.json.zst');
    expect(bytes).toBeDefined();
    expect(Buffer.from(bytes ?? []).toString('utf8')).not.toBe(JSON.stringify(value));
    expect(JSON.parse(Buffer.from(Bun.zstdDecompressSync(bytes ?? new Uint8Array())).toString('utf8'))).toEqual(value);
    await expect(store.getJson('payload.json.zst')).resolves.toEqual(value);
  });

  test('rejects top-level values that JSON.stringify cannot represent', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client);

    await expect(store.putJson('undefined', undefined)).rejects.toThrow(
      "Refusing to store a non-JSON-serialisable payload at 'undefined'",
    );
    await expect(store.putJson('function', () => undefined)).rejects.toThrow('non-JSON-serialisable');
    await expect(store.putJson('symbol', Symbol('value'))).rejects.toThrow('non-JSON-serialisable');
    expect(client.objects.size).toBe(0);
  });

  test('returns null for a missing object and surfaces corrupt payloads', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client);
    client.objects.set('corrupt', new Uint8Array([1, 2, 3]));

    await expect(store.getJson('missing')).resolves.toBeNull();
    await expect(store.getJson('corrupt')).rejects.toThrow();
  });

  test('batch reads de-duplicate keys and omit missing, corrupt, and failed objects', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client);
    await store.putJson('healthy-a', { value: 'a' });
    await store.putJson('healthy-b', { value: 'b' });
    client.objects.set('corrupt', new Uint8Array([1, 2, 3]));
    client.failedReads.add('failed');

    const result = await store.getManyJson(['healthy-a', 'healthy-a', 'missing', 'failed', 'corrupt', 'healthy-b']);

    expect([...result.entries()]).toEqual([
      ['healthy-a', { value: 'a' }],
      ['healthy-b', { value: 'b' }],
    ]);
    expect(client.readCounts.get('healthy-a')).toBe(1);
    expect(client.readCounts.get('missing')).toBe(1);
    expect(client.readCounts.get('failed')).toBe(1);
    expect(client.readCounts.get('corrupt')).toBe(1);
  });

  test('batch reads never exceed the configured concurrency', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client, { maxConcurrentReads: 2 });
    const paths = Array.from({ length: 7 }, (_, index) => `payload-${index}`);
    await Promise.all(paths.map((path, index) => store.putJson(path, { index })));
    client.readDelayMs = 5;

    const result = await store.getManyJson(paths);

    expect(result.size).toBe(paths.length);
    expect(client.maximumActiveReads).toBe(2);
  });

  test('rejects a concurrency setting that would silently skip every read', () => {
    const client = new MemoryObjectStorageClient();

    expect(() => new CompressedJsonStore(client, { maxConcurrentReads: 0 })).toThrow(
      'maxConcurrentReads must be a positive integer',
    );
    expect(() => new CompressedJsonStore(client, { maxConcurrentReads: 1.5 })).toThrow(
      'maxConcurrentReads must be a positive integer',
    );
  });

  test('deletes each unique path once and propagates deletion failures', async () => {
    const client = new MemoryObjectStorageClient();
    const store = new CompressedJsonStore(client);
    client.objects.set('one', new Uint8Array([1]));
    client.objects.set('two', new Uint8Array([2]));

    await store.deleteMany(['one', 'one', 'two']);

    expect(client.deleteCalls).toEqual(['one', 'two']);
    expect(client.objects.size).toBe(0);

    client.failedDeletes.add('failed');
    await expect(store.delete('failed')).rejects.toThrow('delete failed: failed');
  });
});

describe('createObjectStorage', () => {
  test('publishes the constructed shared store', () => {
    const created = createObjectStorage({
      bucket: 'unit-test',
      endpoint: 'http://127.0.0.1:1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });

    expect(created).toBeInstanceOf(CompressedJsonStore);
    expect(objectStorage).toBe(created);
  });
});
