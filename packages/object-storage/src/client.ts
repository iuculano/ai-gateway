import { CompressedJsonStore } from './compressed-json-store';
import { S3ObjectStorageClient } from './object-storage-s3';

/**
 * Builds a store from the environment.
 *
 * S3_ENDPOINT is optional - omit it for real AWS, set it for MinIO and friends.
 * The rest have no defaults on purpose: writing payloads to the wrong bucket, or
 * to a bucket nobody meant to authenticate against, is worse than not writing
 * them at all.
 */
export function createObjectStorageFromEnvironment(): CompressedJsonStore {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('Missing object storage bucket. Set S3_BUCKET.');
  }

  return new CompressedJsonStore(
    new S3ObjectStorageClient({
      bucket: bucket,
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      sessionToken: process.env.S3_SESSION_TOKEN,
    }),
  );
}

let store: CompressedJsonStore | undefined;

/**
 * The shared store, constructed on first use rather than at import time.
 *
 * Eager construction meant that merely importing this module - which every
 * consumer does - threw when the S3 variables were unset. That fired during
 * module evaluation, so it beat the app's own environment validation and
 * surfaced as a bare error from inside this package instead of a named missing
 * variable. Same reasoning as @repo/drizzle's client.
 *
 * Methods are bound to the real store so `this` is never the proxy.
 */
export const objectStorage: CompressedJsonStore = new Proxy({} as CompressedJsonStore, {
  get(_target, property) {
    store ??= createObjectStorageFromEnvironment();

    const value = Reflect.get(store, property);
    return typeof value === 'function' ? value.bind(store) : value;
  },
});
