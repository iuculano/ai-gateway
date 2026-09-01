import { CompressedJsonStore } from './compressed-json-store';
import { S3ObjectStorageClient, type S3ObjectStorageClientOptions } from './object-storage-s3';

/**
 * The shared object store.
 */
export let objectStorage: CompressedJsonStore;

/**
 * Builds the shared object store.
 *
 * @param options
 * S3 connection options.
 *
 * @returns
 * The constructed store.
 */
export function createObjectStorage(options: S3ObjectStorageClientOptions): CompressedJsonStore {
  objectStorage = new CompressedJsonStore(new S3ObjectStorageClient(options));
  return objectStorage;
}
