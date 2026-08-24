import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
const serviceHost = existsSync('/.dockerenv') ? 'host.docker.internal' : '127.0.0.1';

// A dedicated logical database keeps browser sessions away from the frontend
// integration suite (/13) and the other Redis-backed tests (/14 and /15).
const configuredRedis = process.env.REDIS_E2E_URL;
const redisUrl = configuredRedis ?? `redis://${serviceHost}:6379/12`;

if (!configuredRedis) {
  await run(['docker', 'compose', 'up', '--detach', '--wait', 'valkey'], repositoryRoot);
}

await run(
  [process.execPath, 'run', '--cwd', 'apps/gateway-frontend', 'test:e2e', ...process.argv.slice(2)],
  repositoryRoot,
  { ...process.env, REDIS_URL: redisUrl },
);
