import { createRoute } from '@hono/zod-openapi';
import Schemas from './logs.schemas';


const getLog = createRoute({
  method: 'get' as const,
  path: '/logs/:id',
  request: {
    params: Schemas.getLogRequest,
  },
  responses: {
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getLogResponse,
        },
      },
    },
  },
});

const listLogs = createRoute({
  method: 'get' as const,
  path: '/logs',
  request: {
    query: Schemas.listLogsRequest,
  },
  responses: {
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listLogsResponse,
        },
      },
    },
  },
});

export default {
  getLog,
  listLogs
}
