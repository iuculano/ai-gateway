import { AsyncLocalStorage } from 'node:async_hooks';
import { type Logger, logger as rootLogger } from '@repo/core';
import { createMiddleware } from 'hono/factory';
import type { Caller } from './authenticate';

/**
 * Maintains the caller and logger for the current asynchronous flow.
 *
 * In English, provides a way to get the caller and logger from service calls
 * without needing to explicitly pass the context (or value from the context)
 * through every function call.
 */
interface AmbientScope {
  caller: Caller;
  logger: Logger;
}

const store = new AsyncLocalStorage<AmbientScope>();

/**
 * Returns the authenticated caller bound to the current asynchronous flow.
 *
 * @throws
 * If no caller is active in the current asynchronous flow.
 *
 * @returns
 * The authenticated caller bound to the current asynchronous flow.
 */
export function getCaller(): Caller {
  const scope = store.getStore();
  if (!scope) {
    throw new Error('No caller is active - has callerContext() been added to the middleware chain?');
  }

  return scope.caller;
}

/**
 * Returns the request logger when one is active, or the process logger
 * otherwise.
 *
 * @returns
 * The request logger bound to the current asynchronous flow, or the process
 * logger if none is bound.
 */
export function getLogger(): Logger {
  return store.getStore()?.logger ?? rootLogger;
}

export interface RunWithCallerOptions {
  logger?: Logger;
}



/** The identity recorded as the actor of an operation. */
export function getActorId(caller: Caller): string {
  return caller.actor.type === 'api_key' ? caller.actor.key.id : caller.actor.user.id;
}

/** The human accountable for an operation, including one performed through an API key. */
export function getAccountableUserId(caller: Caller): string {
  return caller.actor.type === 'api_key' ? caller.actor.owner.id : caller.actor.user.id;
}

/** Binds a caller and its logger for the duration of `work`. */
export function runWithCaller<T>(caller: Caller, work: () => T, options: RunWithCallerOptions = {}): T {
  const logger = options.logger ?? store.getStore()?.logger ?? rootLogger;
  return store.run({ caller, logger }, work);
}

/** Binds the authenticated Hono caller to the rest of the request's asynchronous flow. */
export function callerContext() {
  return createMiddleware(async (c, next) => {
    return runWithCaller(c.var.caller, next, { logger: c.var.logger });
  });
}
