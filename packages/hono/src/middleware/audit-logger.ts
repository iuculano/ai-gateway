import type { ValidatedToken } from '@repo/auth';
import {
  type Context,
  type Next,
} from 'hono';

import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception';

import { redis } from '@repo/redis';

export interface AuditLoggerOptions {
  key: string;
  ignoreGet?: boolean;
}

/**
 * Middleware that writes audit events to a Redis stream.
 *
 * @returns
 * An async middleware function.
 */
export function auditLogger(options: AuditLoggerOptions) {
  const key = options.key || 'audit-logs';

  return createMiddleware(async (c: Context, next: Next) => {
    // Optionally ignore GET requests since they can be _very_ chatty.
    // Just skip this middleware in this case.
    if (options.ignoreGet && c.req.method === 'GET') {
      return next();
    }

    // Quick sanity chekc up front...
    const jwt = c.get('jwt') as ValidatedToken;
    if (!jwt) {
      // Maybe think of something better to do here?
      // Somehow our session is borked, we should have failed somewhere earlier
      // already. If we made it here, we'd be missing data for the audit event.
      throw new HTTPException(401);
    }

    // Want to log after the response.
    await next();

    const id = await redis.xAdd(key, '*', {
      organizationId: jwt.organization.id,
      timestamp: String(Date.now()),
      actor: jwt.user.username || jwt.user.email,
      method: c.req.method,
      route: c.req.path,
      status: String(c.res.status),
      requestId: c.req.header('x-request-id') || '',
      ip: '',
    }, {
      // TODO: Is there a way to detect this? If the stream is getting this
      // saturated, I think it's going to start dropping events??
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 1000000 },
    });

    if (!id) {
      console.log('Failed to log audit event');
    }
  });
};
