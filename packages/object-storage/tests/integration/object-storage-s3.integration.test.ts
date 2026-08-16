import { describe, expect, test } from 'bun:test';
import { CompressedJsonStore } from '../../index';
import { client, testObjectPath } from './setup';

describe('S3ObjectStorageClient', () => {
  test('writes, overwrites, reads, checks, and deletes exact bytes', async () => {
    const path = testObjectPath('bytes.bin');

    await expect(client.read(path)).resolves.toBeNull();
    await expect(client.exists(path)).resolves.toBe(false);

    await client.write(path, new Uint8Array([0, 1, 2, 255]));
    expect(Array.from((await client.read(path)) ?? [])).toEqual([0, 1, 2, 255]);
    await expect(client.exists(path)).resolves.toBe(true);

    await client.write(path, new Uint8Array([9, 8, 7]));
    expect(Array.from((await client.read(path)) ?? [])).toEqual([9, 8, 7]);

    await client.delete(path);
    await expect(client.read(path)).resolves.toBeNull();
    await expect(client.exists(path)).resolves.toBe(false);
    await expect(client.delete(path)).resolves.toBeUndefined();
  });

  test('supports nested keys that require URL encoding', async () => {
    const path = testObjectPath('nested path/ünicode payload.json');
    const bytes = new TextEncoder().encode('{"healthy":true}');

    await client.write(path, bytes);

    expect(Array.from((await client.read(path)) ?? [])).toEqual(Array.from(bytes));
  });
});

describe('CompressedJsonStore over S3', () => {
  test('round-trips compressed JSON and removes it', async () => {
    const store = new CompressedJsonStore(client);
    const path = testObjectPath('payload.json.zst');
    const payload = {
      request: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] },
      usage: { input_tokens: 4, output_tokens: 2 },
    };

    await store.putJson(path, payload);

    await expect(store.getJson(path)).resolves.toEqual(payload);
    await expect(client.exists(path)).resolves.toBe(true);

    await store.delete(path);

    await expect(store.getJson(path)).resolves.toBeNull();
  });
});
