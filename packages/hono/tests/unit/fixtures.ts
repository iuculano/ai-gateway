import type { Logger } from '@repo/core';
import { KEY_ID, ORGANIZATION_ID, USER_ID } from '@repo/test-helpers';
import type { Caller, CallerIdentity } from '../../src/middleware/authenticate';

const common = {
  organization: { id: ORGANIZATION_ID, name: 'acme' },
  permissions: { scopes: ['logs:read', 'models:read'] },
};

export const userIdentity = {
  ...common,
  actor: {
    type: 'user',
    user: {
      id: USER_ID,
      username: 'alex',
      email: 'alex@example.test',
      displayName: 'Alex',
    },
  },
} satisfies CallerIdentity;

export const apiKeyIdentity = {
  ...common,
  actor: {
    type: 'api_key',
    key: {
      id: KEY_ID,
      name: 'ci',
    },
    owner: userIdentity.actor.user,
  },
} satisfies CallerIdentity;

const request = {
  id: 'request-1',
  ipAddress: '192.0.2.42',
  userAgent: 'test',
};

export const userCaller = { ...userIdentity, request } satisfies Caller;
export const apiKeyCaller = { ...apiKeyIdentity, request } satisfies Caller;

export interface LogCall {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  data: unknown;
  message: unknown;
}

export function createTestLogger() {
  const calls: LogCall[] = [];
  const childBindings: unknown[] = [];

  const log = (level: LogCall['level']) => (data: unknown, message: unknown) => {
    calls.push({ level, data, message });
  };

  const logger = {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    child(bindings: unknown) {
      childBindings.push(bindings);
      return logger;
    },
  } as unknown as Logger;

  return { logger, calls, childBindings };
}
