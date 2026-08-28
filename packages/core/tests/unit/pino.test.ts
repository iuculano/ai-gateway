import { expect, test } from 'bun:test';
import { logger } from '../../index';

test('exports the configured logger through the package entry point', () => {
  expect(logger.level).toBe(process.env.LOG_LEVEL ?? 'info');
  expect(logger.bindings()).toMatchObject({
    'service.name': process.env.SERVICE_NAME ?? 'gateway-api',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });
});

test('child loggers retain their structured bindings', () => {
  const child = logger.child({ component: 'core-test', request_id: 'request-123' });

  expect(child.bindings()).toMatchObject({
    component: 'core-test',
    request_id: 'request-123',
  });
});
