import { S3Client } from 'bun';

export const s3 = new S3Client({
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'gateway-api',
  endpoint: 'http://localhost:9000',
});
