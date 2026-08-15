import { S3Client } from 'bun';
import type { ObjectStorageClient } from './object-storage';

export interface S3ObjectStorageClientOptions {
  bucket: string;
  /** Omit for real AWS; set it for MinIO and other S3-compatible stores. */
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
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
      sessionToken: options.sessionToken,
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
 * Whether an error from the S3 client means "no such object".
 *
 * Deliberately narrow. AccessDenied is NOT treated as absence even though some
 * S3-compatible stores return it in place of NoSuchKey - a credential or policy
 * problem that reads as "no data" is a misconfiguration that would look like an
 * empty store and never get investigated.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'NoSuchKey' || code === 'ERR_S3_FILE_NOT_FOUND' || name === 'NoSuchKey';
}
