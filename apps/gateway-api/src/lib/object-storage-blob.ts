import { S3Client } from 'bun';
import { type ObjectStorageClient } from '@lib/object-storage';


export interface BlobObjectStorageClientOptions {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class BlobObjectStorageClient implements ObjectStorageClient {
  private s3: S3Client;

  constructor(options: BlobObjectStorageClientOptions) {
    this.s3 = new S3Client({
      region: options.region || 'us-east-1',
      endpoint: options.endpoint,
      bucket: options.bucket,

      // This should be undefined when using a role
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,      
    });
  }

  async read(path: string): Promise<Uint8Array> {
    const buffer = await this.s3.file(path).arrayBuffer();
    const data = new Uint8Array(buffer);

    return data;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.s3.file(path).write(data);
  }
}
