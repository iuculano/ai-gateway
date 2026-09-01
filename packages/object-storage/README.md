# @repo/object-storage

Wrapper around object storage.

Used by log storage, in practice.

## Tests

```bash
S3_TEST_ENDPOINT=http://host.docker.internal:9000 \
S3_TEST_ACCESS_KEY_ID=minioadmin \
S3_TEST_SECRET_ACCESS_KEY=minioadmin \
S3_TEST_BUCKET=ai-gateway-logs-test \
S3_TEST_REGION=us-east-1 \
bun run --cwd packages/object-storage test:integration
```
