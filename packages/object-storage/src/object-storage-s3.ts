import { S3Client } from 'bun';
import type { ObjectStorageClient } from './object-storage';

/**
 * Options for constructing an S3ObjectStorageClient.
 */
export interface S3ObjectStorageClientOptions {
  /** The S3 bucket name. */
  bucket: string;

  /** The S3 endpoint URL. Optional for AWS. */
  endpoint?: string;

  /** The S3 region. */
  region?: string;

  /** The S3 access key ID. */
  accessKeyId?: string;

  /** The S3 secret access key. */
  secretAccessKey?: string;
}

/**
 * S3 and anything that speaks its API - MinIO, R2, Backblaze.
 *
 * Built on Bun's own S3 client, so there is no SDK dependency here.
 */
export class S3ObjectStorageClient implements ObjectStorageClient {
  private readonly s3: S3Client;

  constructor(options: S3ObjectStorageClientOptions) {
    this.s3 = new S3Client({
      region: options.region ?? 'us-east-1',
      endpoint: options.endpoint,
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    });
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      return await this.s3.file(path).bytes();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.s3.file(path).write(data);
  }

  async delete(path: string): Promise<void> {
    try {
      await this.s3.file(path).delete();
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.s3.file(path).exists();
  }
}

/**
 * Helper to try and figure out if an error actually means "not found."
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'NoSuchKey' || code === 'ERR_S3_FILE_NOT_FOUND' || name === 'NoSuchKey';
}
