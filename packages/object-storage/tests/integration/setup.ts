import { afterEach } from 'bun:test';
import { S3ObjectStorageClient, type S3ObjectStorageClientOptions } from '../../index';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is unset. Start MinIO and provide the S3_TEST_* values documented in ` +
        'packages/object-storage/README.md.',
    );
  }

  return value;
}

const bucket = required('S3_TEST_BUCKET');
if (!/[-_]test$/.test(bucket)) {
  throw new Error(`Refusing to run object-storage integration tests against non-test bucket "${bucket}".`);
}

const options: S3ObjectStorageClientOptions = {
  endpoint: required('S3_TEST_ENDPOINT'),
  bucket,
  accessKeyId: required('S3_TEST_ACCESS_KEY_ID'),
  secretAccessKey: required('S3_TEST_SECRET_ACCESS_KEY'),
  region: process.env.S3_TEST_REGION ?? 'us-east-1',
};

export const client = new S3ObjectStorageClient(options);

const prefix = `tests/object-storage/${crypto.randomUUID()}`;
const paths = new Set<string>();

export function testObjectPath(name: string): string {
  const path = `${prefix}/${crypto.randomUUID()}/${name}`;
  paths.add(path);
  return path;
}

afterEach(async () => {
  await Promise.all([...paths].map((path) => client.delete(path)));
  paths.clear();
});
