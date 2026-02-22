import type { ValidatedToken } from '@repo/auth';
import type {
  Context,
  Next,
} from 'hono';

import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception';


interface AuthorizeOptions {
  roles: string[];
}

/**
 * Middleware that logs incoming HTTP requests and their responses.
 *
 * This effectively:
 * - Attaches a child logger to the context.
 * - Logs the start and end of each request.
 * - Includes request metadata such as request ID, path, method, response
 *   status, and duration in milliseconds.
 *
 * @returns
 * An async middleware function.
 */
export const authorize = (options: AuthorizeOptions) =>
  createMiddleware(async (c: Context, next: Next) => {
    const jwt = c.get('jwt') as unknown as ValidatedToken;
    const role = jwt.user.role;
    if (!role) {
      throw new HTTPException(403);
    }

    const isAllowed = options.roles.includes(role);
    if (!isAllowed) {
      throw new HTTPException(403);
    }

    await next();
});
