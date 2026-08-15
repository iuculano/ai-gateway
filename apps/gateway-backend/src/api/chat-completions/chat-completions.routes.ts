import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize } from '@repo/hono';
import { bearerSecurity, validatedProtectedRouteErrors } from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './chat-completions.schemas';

/**
 * POST /chat/completions
 *
 * Database writes on this streaming path receive the organization explicitly,
 * because they can finish after the request's asynchronous context has ended.
 */
const createChatCompletion = createRoute({
  method: 'post' as const,
  path: '/chat/completions',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.chatCompletionsWrite] })],
  request: {
    headers: Schemas.createChatCompletion.headers,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createChatCompletion.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Chat completion generated',
      content: {
        'application/json': {
          schema: Schemas.createChatCompletion.response,
        },

        // text/event-stream, not application/event-stream - the latter is not
        // a registered media type and EventSource ignores it.
        'text/event-stream': {
          schema: Schemas.completionChunk,
        },
      },
    },
    400: {
      description: 'Malformed request, or a parameter this gateway cannot honour',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    401: {
      description: 'Gateway authentication failed, or the upstream provider rejected the supplied ai-api-key',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    429: {
      description: 'Rate limit exceeded, either here or upstream',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    502: {
      description: 'The upstream provider failed',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    504: {
      description: 'The upstream provider timed out',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  createChatCompletion,
};
