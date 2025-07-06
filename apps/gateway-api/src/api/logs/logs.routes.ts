import { createRoute } from '@hono/zod-openapi';
import Schemas from './logs.schemas';

// Example: your logsQuerySchema should match the query params you support
const getLogs = createRoute({
  method: 'get',
  path: '/logs',
  request: {
    query: Schemas.getLogsRequest,
  },
  responses: {
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getLogsResponse,
        },
      },
    },
  },
});

export default {
  getLogs,
}
