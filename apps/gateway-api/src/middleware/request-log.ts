import { 
  type Context,
  type Next,
} from 'hono';

import logger from '../clients/pino';


export function requestLogger() {
  return async (c: Context, next: Next) => {
    const requestId = c.var?.requestId;
    const childLogger = logger.child({ 
      "id    ": requestId, 
      "path  ": c.req.path,
      "method": c.req.method,
    });

    // Make it available for others to use
    c.set('logger', childLogger);

    const startTime = Date.now();
    childLogger.trace('Request started');

    await next();

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    childLogger.trace(
      {
        "delta ": durationMs,
        "status": c.res.status,
      },
      'Request finished'
    );
  };
}
