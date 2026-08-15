import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Actor } from './authenticate';

export interface AuthorizeOptions {
  scopes?: readonly string[];

  /** Caller actor types allowed to reach the route. Omit to allow every type. */
  actorTypes?: readonly Actor['type'][];
}

/**
 * Middleware that authorizes a request against the Caller attached by
 * authenticate() - it must run after it in the chain.
 *
 * Actor-type checks run before scope checks. Scope checks are conjunctive.
 * 
 * @param options 
 * Set of options to configure the middleware.
 *
 * @returns
 * An async middleware function.
 */
export function authorize(options: AuthorizeOptions = {}) {
  return createMiddleware(async (c: Context, next: Next) => {
    const caller = c.var.caller;
    if (!caller) {
      // authenticate() middleware hasn't run, so there's no caller to check
      // against - AKA we're sunk, bail.
      throw new HTTPException(401, {
        cause: 'Missing caller in context - has authenticate() middleware run?',
      });
    }

    if (options.actorTypes && !options.actorTypes.includes(caller.actor.type)) {
      throw new HTTPException(403, {
        cause: `Caller type '${caller.actor.type}' is not allowed - expected one of '${options.actorTypes.join(' ')}'`,
      });
    }

    if (options.scopes?.length) {
      const granted = caller.permissions.scopes;
      const missing = options.scopes.filter((scope) => !granted.includes(scope));

      if (missing.length > 0) {
        throw new HTTPException(403, {
          cause: `Missing required scopes - got '${granted.join(' ')}', missing '${missing.join(' ')}'`,

          res: new Response(null, {
            headers: {
              'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${options.scopes.join(' ')}"`,
            },
          }),
        });
      }
    }

    await next();
  });
}
