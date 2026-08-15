import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
import { authorize } from '@repo/hono';
import { bearerSecurity, validatedProtectedRouteErrors } from '../../../../../packages/hono/src/openapi/route-helpers';
import { SCOPES } from '../../authorization';
import Schemas from './guardrails.schemas';

/**
 * Reading the rules and running them is guardrailsRead; changing what the
 * gateway will refuse is guardrailsWrite. Evaluation lands on the read side
 * deliberately - it mutates nothing, and requiring write access to check a
 * string would mean handing out rule-editing rights to every caller that only
 * wants a pre-flight check.
 */
const evaluateGuardrails = createRoute({
  method: 'post' as const,
  path: '/guardrails/evaluate',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsRead] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.evaluateGuardrails.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Content evaluated successfully',
      content: {
        'application/json': {
          schema: Schemas.evaluateGuardrails.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

//---

const createRegexGuardrail = createRoute({
  method: 'post' as const,
  path: '/guardrails/regex',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsWrite] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createRegexGuardrail.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    201: {
      description: 'Guardrail created successfully',
      content: {
        'application/json': {
          schema: Schemas.createRegexGuardrail.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

// Typed per guardrail type, like creation, so the config schema in the OpenAPI
// document stays concrete. The alternative - one PATCH /guardrails/:id - can
// only document config as an open object, because the type is not known until
// the row is read.
const updateRegexGuardrail = createRoute({
  method: 'patch' as const,
  path: '/guardrails/regex/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsWrite] })],
  request: {
    params: Schemas.updateRegexGuardrail.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updateRegexGuardrail.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Guardrail updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updateRegexGuardrail.response,
        },
      },
    },
    404: {
      description: 'Regex guardrail not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

//---

// Reads are type-agnostic: a dashboard listing guardrails wants all of them,
// not one query per type.
const listGuardrails = createRoute({
  method: 'get' as const,
  path: '/guardrails',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsRead] })],
  request: {
    query: Schemas.listGuardrails.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Guardrails retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listGuardrails.response,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const getGuardrail = createRoute({
  method: 'get' as const,
  path: '/guardrails/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsRead] })],
  request: {
    params: Schemas.getGuardrail.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Guardrail retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getGuardrail.response,
        },
      },
    },
    404: {
      description: 'Guardrail not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

const deleteGuardrail = createRoute({
  method: 'delete' as const,
  path: '/guardrails/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.guardrailsWrite] })],
  request: {
    params: Schemas.deleteGuardrail.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Guardrail deleted successfully',
    },
    404: {
      description: 'Guardrail not found',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: httpError,
        },
      },
    },
  },
});

export default {
  evaluateGuardrails,

  createRegexGuardrail,
  updateRegexGuardrail,

  listGuardrails,
  getGuardrail,
  deleteGuardrail,
};
