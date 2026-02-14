import {
  type Context,
  type Next,
} from 'hono';

import { createMiddleware } from 'hono/factory'
import { validateJwt, type ValidatedToken } from '@lib/auth';

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
interface Variables { 
  Variables: { 
    jwt: ValidatedToken | null 
  }
};

export const authenticate = () =>
  createMiddleware<Variables>(async (c: Context, next: Next) => {
    // I think Zod can just validate this for us? Need to check...
    // const header = c.req.header('Authorization');
    // if (!header) {
    //   throw new HTTPException(401, {
    //     message: 'Missing Authorization header.',
    //   });
    // }

    // const split = header.split(' ');
    // if (split.length !== 2 || split[0] !== 'Bearer') {
    //   throw new HTTPException(401, {
    //     message: 'Invalid Authorization header format.
    //   });
    // }

    // const token = split[1];
    // if (!token) {
    //   throw new HTTPException(401, {
    //     message: 'Missing token in Authorization header.',
    //   });
    // }
    
    const header = c.req.header('Authorization');
    const token = header?.split(' ')[1];

    const result = await validateJwt(token as string);
    c.set('jwt', result);

    await next();
  }
);
