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

const getLogData = createRoute({
  method: 'get' as const,
  path: '/logs/:id/data',
  request: {
    params: Schemas.getLogRequest,
  },
  responses: {
    200: {
      description: 'Logs retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getLogDataResponse,
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

const createLog = createRoute({
  method: 'post' as const,
  path: '/logs',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createLogRequest,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Log created successfully',
      content: {
        'application/json': {
          schema: Schemas.createLogResponse,
        },
      },
    },
  },
});

const updateLog = createRoute({
  method: 'patch' as const,
  path: '/logs/:id',
  request: {
    params: Schemas.getLogRequest,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateLogRequest,
        },
      },
    },
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

export default {
  getLog,
  getLogData,
  listLogs,
  createLog,
  updateLog,
}
