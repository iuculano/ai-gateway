import { describe, expect, test } from 'bun:test';
import { type S3FileApi, S3ObjectStorageClient } from '../../src/object-storage-s3';

/**
 * The adapter's own logic, which is almost entirely error classification.
 *
 * The happy paths are covered against real MinIO in the integration tier. What
 * that tier cannot do cheaply is produce each distinct not-found error shape on
 * demand - S3, MinIO, R2 and Backblaze do not agree on one - so those branches
 * are exercised here with fabricated failures instead.
 */

const OPTIONS = { bucket: 'test-bucket' };

/** A stand-in whose every operation resolves, unless told to throw. */
function fakeS3(behaviour: Partial<Record<'bytes' | 'write' | 'delete' | 'exists', () => Promise<unknown>>> = {}) {
  const calls: string[] = [];

  const api: S3FileApi = {
    file(path: string) {
      calls.push(path);
      return {
        bytes: async () => (behaviour.bytes ? ((await behaviour.bytes()) as Uint8Array) : new Uint8Array([1, 2, 3])),
        write: async (data: Uint8Array) => (behaviour.write ? behaviour.write() : data),
        delete: async () => (behaviour.delete ? behaviour.delete() : undefined),
        exists: async () => (behaviour.exists ? ((await behaviour.exists()) as boolean) : true),
      };
    },
  };

  return { api, calls };
}

/** The three shapes the adapter is expected to read as "not found". */
const NOT_FOUND_SHAPES: [string, unknown][] = [
  ['code NoSuchKey', Object.assign(new Error('missing'), { code: 'NoSuchKey' })],
  ['code ERR_S3_FILE_NOT_FOUND', Object.assign(new Error('missing'), { code: 'ERR_S3_FILE_NOT_FOUND' })],
  ['name NoSuchKey', Object.assign(new Error('missing'), { name: 'NoSuchKey' })],
];

describe('read', () => {
  test('returns the object bytes', async () => {
    const { api, calls } = fakeS3();
    const client = new S3ObjectStorageClient(OPTIONS, api);

    expect(await client.read('logs/abc.json')).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual(['logs/abc.json']);
  });

  for (const [label, error] of NOT_FOUND_SHAPES) {
    test(`returns null rather than throwing on ${label}`, async () => {
      const { api } = fakeS3({
        bytes: () => Promise.reject(error),
      });

      // Null is the contract callers depend on: /request and /response turn it
      // into a 404, where a thrown error would become a 500.
      expect(await new S3ObjectStorageClient(OPTIONS, api).read('gone')).toBeNull();
    });
  }

  test('rethrows anything that is not a missing object', async () => {
    const denied = Object.assign(new Error('access denied'), { code: 'AccessDenied' });
    const { api } = fakeS3({ bytes: () => Promise.reject(denied) });

    // Swallowing this would report a permissions failure as an absent object,
    // which reads as data loss rather than a misconfiguration.
    expect(new S3ObjectStorageClient(OPTIONS, api).read('secret')).rejects.toThrow('access denied');
  });

  test('does not mistake a non-object rejection for not found', async () => {
    const { api } = fakeS3({ bytes: () => Promise.reject('just a string') });

    expect(new S3ObjectStorageClient(OPTIONS, api).read('odd')).rejects.toBe('just a string');
  });
});

describe('delete', () => {
  test('resolves on success', async () => {
    const { api, calls } = fakeS3();

    await new S3ObjectStorageClient(OPTIONS, api).delete('logs/abc.json');
    expect(calls).toEqual(['logs/abc.json']);
  });

  for (const [label, error] of NOT_FOUND_SHAPES) {
    test(`treats ${label} as already deleted`, async () => {
      const { api } = fakeS3({ delete: () => Promise.reject(error) });

      // Deletion is idempotent by design: retention sweeps and repeated
      // erasure requests must not fail because the object went first.
      expect(new S3ObjectStorageClient(OPTIONS, api).delete('gone')).resolves.toBeUndefined();
    });
  }

  test('rethrows a real failure', async () => {
    const denied = Object.assign(new Error('access denied'), { code: 'AccessDenied' });
    const { api } = fakeS3({ delete: () => Promise.reject(denied) });

    expect(new S3ObjectStorageClient(OPTIONS, api).delete('secret')).rejects.toThrow('access denied');
  });
});

describe('write', () => {
  test('passes the bytes through unaltered', async () => {
    // Collected rather than assigned to a nullable: TypeScript cannot prove the
    // callback ran, so a `let written: Uint8Array | null` stays narrowed to null
    // at the assertion. An array also states that write happened exactly once.
    const written: Uint8Array[] = [];

    const api: S3FileApi = {
      file: () => ({
        bytes: async () => new Uint8Array(),
        write: async (data: Uint8Array) => {
          written.push(data);
          return data;
        },
        delete: async () => undefined,
        exists: async () => true,
      }),
    };

    const payload = new Uint8Array([9, 8, 7]);
    await new S3ObjectStorageClient(OPTIONS, api).write('logs/x', payload);

    expect(written).toEqual([payload]);
  });

  test('surfaces a write failure instead of silently dropping the object', async () => {
    const { api } = fakeS3({ write: () => Promise.reject(new Error('bucket full')) });

    // No not-found handling on this path on purpose - a failed write has no
    // benign interpretation, and swallowing it would lose a payload while the
    // log row kept claiming it existed.
    expect(new S3ObjectStorageClient(OPTIONS, api).write('logs/x', new Uint8Array([1]))).rejects.toThrow('bucket full');
  });
});

describe('exists', () => {
  test('reports presence and absence', async () => {
    const present = fakeS3({ exists: () => Promise.resolve(true) });
    const absent = fakeS3({ exists: () => Promise.resolve(false) });

    expect(await new S3ObjectStorageClient(OPTIONS, present.api).exists('here')).toBe(true);
    expect(await new S3ObjectStorageClient(OPTIONS, absent.api).exists('nowhere')).toBe(false);
  });

  test('does not translate an error into false', async () => {
    const { api } = fakeS3({ exists: () => Promise.reject(new Error('network down')) });

    // Returning false here would make an outage indistinguishable from a
    // deleted object, and a retention sweep would act on the difference.
    expect(new S3ObjectStorageClient(OPTIONS, api).exists('unknown')).rejects.toThrow('network down');
  });
});
