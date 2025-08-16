import { S3Client } from 'bun';


const s3 = new S3Client({
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  bucket: 'gateway-api',
  endpoint: 'http://localhost:9000', // MinIO endpoint
});

export {
  s3
};
