import { expect, test } from 'bun:test';
import { logger as rootLogger } from '@repo/core';
import { type Caller, getAccountableUserId, getActorId, getCaller, getLogger, runWithCaller } from '@repo/hono';

const common = {
  organization: { id: '01912d3f-9b4a-7c3d-8e2f-000000000001', name: 'acme' },
  permissions: { scopes: ['logs:read'] },
  request: {
    id: 'request-1',
    ipAddress: '192.0.2.42',
    userAgent: 'test',
  },
};

const userCaller = {
  ...common,
  actor: {
    type: 'user',
    user: {
      id: '01912d3f-9b4a-7c3d-8e2f-000000000002',
      username: 'alex',
      email: 'alex@example.test',
    },
  },
} satisfies Caller;

const apiKeyCaller = {
  ...common,
  actor: {
    type: 'api_key',
    key: {
      id: '01912d3f-9b4a-7c3d-8e2f-000000000003',
      name: 'ci',
    },
    owner: userCaller.actor.user,
  },
} satisfies Caller;

test('a user is both the actor and the accountable human', () => {
  expect(getActorId(userCaller)).toBe(userCaller.actor.user.id);
  expect(getAccountableUserId(userCaller)).toBe(userCaller.actor.user.id);
});

test('an API key is the actor while its owner is the accountable human', () => {
  expect(getActorId(apiKeyCaller)).toBe(apiKeyCaller.actor.key.id);
  expect(getAccountableUserId(apiKeyCaller)).toBe(apiKeyCaller.actor.owner.id);
});

test('runWithCaller preserves the exact caller and logger across asynchronous work', async () => {
  const logger = rootLogger.child({ test: 'caller-context' });

  await runWithCaller(
    apiKeyCaller,
    async () => {
      await Promise.resolve();
      expect(getCaller()).toBe(apiKeyCaller);
      expect(getLogger()).toBe(logger);
    },
    { logger },
  );
});

test('ambient access outside a caller scope refuses identity but retains the process logger', () => {
  expect(() => getCaller()).toThrow('No caller is active');
  expect(getLogger()).toBe(rootLogger);
});
