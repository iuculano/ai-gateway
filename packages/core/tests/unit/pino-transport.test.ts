import { describe, expect, test } from 'bun:test';

/**
 * Which logger each environment gets, checked from outside this process.
 *
 * The development branch builds a pino.transport(), which spawns a worker
 * thread through thread-stream. Constructing one in THIS process is exactly the
 * thing that used to abort the whole test run - the worker's exit surfaced as an
 * unhandled error and tore the runner down, taking 186 unrelated tests with it.
 *
 * So each case runs in a child process instead. Nothing here can reintroduce
 * that failure, and the assertion below is what stops the transport from
 * quietly coming back for `test`.
 */

const MODULE = new URL('../../src/pino.ts', import.meta.url).pathname;

async function logFrom(nodeEnv: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `process.env.NODE_ENV=${JSON.stringify(nodeEnv)};` +
        `const m = await import(${JSON.stringify(MODULE)}); m.logger.info('probe-message');`,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: nodeEnv } },
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  return { stdout, exitCode };
}

describe('logger transport selection', () => {
  test('test writes plain JSON, with no worker transport', async () => {
    const { stdout, exitCode } = await logFrom('test');

    expect(exitCode).toBe(0);

    // Parseable as JSON is the observable proof that pino-pretty is not in the
    // pipeline - and therefore that no thread-stream worker was started.
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const record = JSON.parse(line);

    expect(record.msg).toBe('probe-message');
    expect(record['service.name']).toBe('gateway-api');
    expect(record['deployment.environment']).toBe('test');
  });

  test('production writes plain JSON', async () => {
    const { stdout, exitCode } = await logFrom('production');

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '').msg).toBe('probe-message');
  });

  test('development pretty-prints instead', async () => {
    const { stdout, exitCode } = await logFrom('development');

    expect(exitCode).toBe(0);
    expect(stdout).toContain('probe-message');

    // pino-pretty emits a human line, not a JSON record. Being unparseable is
    // the point - it is what distinguishes this branch from the other two.
    const line = stdout.trim().split('\n').at(-1) ?? '';
    expect(() => JSON.parse(line)).toThrow();
  });

  test('the service identity pino-pretty is told to hide stays out of dev output', async () => {
    const { stdout } = await logFrom('development');

    // `ignore` in the transport options. Worth asserting because the option is
    // a comma-separated string and a typo in it fails silently.
    expect(stdout).not.toContain('deployment.environment');
    expect(stdout).not.toContain('service.name');
  });
});
