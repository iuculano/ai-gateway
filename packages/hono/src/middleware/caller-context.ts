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
  /**The authenticated caller bound to the current asynchronous flow. */
  caller: Caller;

  /** The request logger bound to the current asynchronous flow. */
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

/**
 * Options for runWithCaller().
 */
export interface RunWithCallerOptions {
  /** The request logger bound to the current asynchronous flow. */
  logger?: Logger;
}

/**
 * Get the identity recorded as the actor of an operation.
 *
 * @param caller
 * The caller to get the actor id for.
 *
 * @returns
 * The id of the actor that performed the operation.
 */
export function getActorId(caller: Caller): string {
  return caller.actor.type === 'api_key' ? caller.actor.key.id : caller.actor.user.id;
}

/**
 * Get the human accountable for an operation, including one performed through
 * an API key.
 *
 * @param caller
 * The caller to get the accountable user for.
 *
 * @returns
 * The user id of the human accountable for the operation.
 */
export function getAccountableUserId(caller: Caller): string {
  return caller.actor.type === 'api_key' ? caller.actor.owner.id : caller.actor.user.id;
}

/**
 * Binds a caller and its logger for the duration of `work`.
 *
 * @param caller
 * The caller to bind for the duration of `work`.
 *
 * @param work
 * The function to execute with the caller and logger bound.
 *
 * @param options
 * Additional options for binding the caller.
 */
export function runWithCaller<T>(caller: Caller, work: () => T, options: RunWithCallerOptions = {}): T {
  const logger = options.logger ?? store.getStore()?.logger ?? rootLogger;
  return store.run({ caller, logger }, work);
}

/**
 * Middleware that binds the authenticated caller to the rest of the request's
 * asynchronous flow.
 *
 * AKA, makes getCaller() and getLogger() work for the rest of the request.
 */
export function callerContext() {
  return createMiddleware(async (c, next) => {
    return runWithCaller(c.var.caller, next, { logger: c.var.logger });
  });
}
