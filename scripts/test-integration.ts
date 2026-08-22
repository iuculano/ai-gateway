import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Runs a command as part of the integration-test bootstrap.
 *
 * Output is inherited so service startup and test failures remain visible in
 * CI. A non-zero exit stops the bootstrap immediately instead of letting a
 * later command obscure the actual failure.
 */
async function run(command: string[], cwd: string, environment = process.env): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: cwd,
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited ${exitCode}`);
  }
}

const repositoryRoot = resolve(import.meta.dir, '..');

// Compose publishes services on the Docker host. A host checkout reaches them
// through localhost; the repository dev container receives the stable host
// alias in devcontainer.json.
const serviceHost = existsSync('/.dockerenv') ? 'host.docker.internal' : 'localhost';

const needsLocalPostgres = !process.env.POSTGRES_TEST_ADMIN_CONNECTION_STRING;
const needsLocalRedis =
  !process.env.REDIS_TEST_URL || !process.env.REDIS_PACKAGE_TEST_URL || !process.env.REDIS_FRONTEND_TEST_URL;
const needsLocalObjectStorage = !process.env.S3_TEST_ENDPOINT;

const localDefaults = {
  POSTGRES_TEST_ADMIN_CONNECTION_STRING: `postgresql://postgres:postgres@${serviceHost}:5432/ai_gateway_test`,
  REDIS_TEST_URL: `redis://${serviceHost}:6379/15`,
  REDIS_PACKAGE_TEST_URL: `redis://${serviceHost}:6379/14`,
  REDIS_FRONTEND_TEST_URL: `redis://${serviceHost}:6379/13`,
  S3_TEST_ENDPOINT: `http://${serviceHost}:9000`,
  S3_TEST_ACCESS_KEY_ID: 'minioadmin',
  S3_TEST_SECRET_ACCESS_KEY: 'minioadmin',
  S3_TEST_BUCKET: 'ai-gateway-logs-test',
  S3_TEST_REGION: 'us-east-1',
} as const;

for (const [name, value] of Object.entries(localDefaults)) {
  process.env[name] ??= value;
}

const services = [
  ...(needsLocalPostgres ? ['postgres'] : []),
  ...(needsLocalRedis ? ['valkey'] : []),
  ...(needsLocalObjectStorage ? ['minio'] : []),
];

if (services.length > 0) {
  await run(['docker', 'compose', 'up', '--detach', '--wait', ...services], repositoryRoot);
}

// Bucket creation is idempotent. Only run it for the compose-backed endpoint;
// an explicitly configured S3 service owns its own provisioning.
if (needsLocalObjectStorage) {
  await run(['docker', 'compose', 'run', '--rm', '-T', 'minio-init'], repositoryRoot);
}

// The turbo dependency prepares the isolated `_test` database before any
// workspace suite begins. Concurrency stays at one because several database
// suites truncate the same test schema between cases.
await run(['bunx', 'turbo', 'run', 'test:integration', '--concurrency=1'], repositoryRoot, process.env);
