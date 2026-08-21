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
 * The slice of Bun's S3Client this adapter actually uses.
 *
 * Named so the constructor can take a stand-in. `bun` is a builtin module and
 * cannot be intercepted with mock.module, so without a seam the only way to
 * reach the error branches below is to make a real bucket produce each error -
 * which is precisely what a unit test should not have to arrange.
 */
export interface S3FileApi {
  file(path: string): {
    bytes(): Promise<Uint8Array>;
    write(data: Uint8Array): Promise<unknown>;
    delete(): Promise<unknown>;
    exists(): Promise<boolean>;
  };
}

/**
 * S3 and anything that speaks its API - MinIO, R2, Backblaze.
 *
 * Built on Bun's own S3 client, so there is no SDK dependency here.
 */
export class S3ObjectStorageClient implements ObjectStorageClient {
  private readonly s3: S3FileApi;

  /**
   * @param options
   * Bucket and credentials.
   *
   * @param s3
   * Overrides the client built from `options`. For tests only; production
   * passes one argument and gets Bun's client.
   */
  constructor(options: S3ObjectStorageClientOptions, s3?: S3FileApi) {
    this.s3 =
      s3 ??
      (new S3Client({
        region: options.region ?? 'us-east-1',
        endpoint: options.endpoint,
        bucket: options.bucket,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      }) as unknown as S3FileApi);
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
