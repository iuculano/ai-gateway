# @repo/object-storage

Byte-level object storage backed by Bun's S3 client, plus a JSON store that
compresses payloads with zstd.

## Unit tests

The unit suite uses an in-memory `ObjectStorageClient`, so it needs no external
services:

```bash
cd packages/object-storage
bun run test
```

## Integration tests

The integration suite verifies the S3 adapter against a real S3-compatible
service. It uses randomized object keys and cleans up only the keys it creates,
but still requires a bucket whose name ends in `-test` or `_test`.

From the repository dev container with the compose MinIO service running:

```bash
cd packages/object-storage
S3_TEST_ENDPOINT=http://host.docker.internal:9000 \
S3_TEST_ACCESS_KEY_ID=minioadmin \
S3_TEST_SECRET_ACCESS_KEY=minioadmin \
S3_TEST_BUCKET=ai-gateway-logs-test \
S3_TEST_REGION=us-east-1 \
bun run test:integration
```
