import { createRoute } from '@hono/zod-openapi';
import { httpError } from '@repo/core';
// All three come from the package root, which re-exports route-helpers. The
// sibling route files reach into '../../../../../packages/hono/src/...' for the
// last two; same symbols, and there is no reason to repeat the deep path here.
import { authorize, bearerSecurity, validatedProtectedRouteErrors } from '@repo/hono';
import { SCOPES } from '../../authorization';
import Schemas from './prompts.schemas';

const jsonErrorContent = {
  'application/json': {
    schema: httpError,
  },
};

const promptNotFound = {
  404: {
    description: 'Prompt not found',
    content: jsonErrorContent,
  },
} as const;

const promptVersionNotFound = {
  404: {
    description: 'Prompt version not found',
    content: jsonErrorContent,
  },
} as const;

/**
 * Reading prompts is promptsRead; creating, editing and versioning them is
 * promptsWrite. Rendering lands on the read side: it resolves a stored template
 * and substitutes values, mutating nothing, so requiring write access to
 * preview a prompt would hand out editing rights to every caller that only
 * wants to see the text it will send.
 */
const createPrompt = createRoute({
  method: 'post' as const,
  path: '/prompts',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPrompt.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    201: {
      description: 'Prompt created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPrompt.response,
        },
      },
    },
    409: {
      description: 'A prompt with that name already exists in this organization',
      content: jsonErrorContent,
    },
  },
});

const listPrompts = createRoute({
  method: 'get' as const,
  path: '/prompts',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsRead] })],
  request: {
    query: Schemas.listPrompts.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompts retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listPrompts.response,
        },
      },
    },
  },
});

const getPrompt = createRoute({
  method: 'get' as const,
  path: '/prompts/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsRead] })],
  request: {
    params: Schemas.getPrompt.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPrompt.response,
        },
      },
    },
    ...promptNotFound,
  },
});

const updatePrompt = createRoute({
  method: 'patch' as const,
  path: '/prompts/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    params: Schemas.updatePrompt.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updatePrompt.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePrompt.response,
        },
      },
    },
    ...promptNotFound,
    409: {
      description: 'A prompt with that name already exists in this organization',
      content: jsonErrorContent,
    },
    422: {
      description: 'active_version names a version that does not exist on this prompt',
      content: jsonErrorContent,
    },
  },
});

const deletePrompt = createRoute({
  method: 'delete' as const,
  path: '/prompts/{id}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    params: Schemas.deletePrompt.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Prompt deleted successfully',
    },
    ...promptNotFound,
  },
});

// ---

const createPromptVersion = createRoute({
  method: 'post' as const,
  path: '/prompts/{id}/versions',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    params: Schemas.createPromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPromptVersion.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    201: {
      description: 'Prompt version created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPromptVersion.response,
        },
      },
    },
    ...promptNotFound,
  },
});

const listPromptVersions = createRoute({
  method: 'get' as const,
  path: '/prompts/{id}/versions',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsRead] })],
  request: {
    params: Schemas.listPromptVersions.params,
    query: Schemas.listPromptVersions.query,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt versions retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listPromptVersions.response,
        },
      },
    },
    ...promptNotFound,
  },
});

const renderPromptVersion = createRoute({
  method: 'post' as const,
  path: '/prompts/{id}/versions/{version}/render',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsRead] })],
  request: {
    params: Schemas.renderPromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.renderPromptVersion.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt version rendered successfully',
      content: {
        'application/json': {
          schema: Schemas.renderPromptVersion.response,
        },
      },
    },
    ...promptVersionNotFound,
  },
});

const getPromptVersion = createRoute({
  method: 'get' as const,
  path: '/prompts/{id}/versions/{version}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsRead] })],
  request: {
    params: Schemas.getPromptVersion.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt version retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPromptVersion.response,
        },
      },
    },
    ...promptVersionNotFound,
  },
});

const updatePromptVersion = createRoute({
  method: 'patch' as const,
  path: '/prompts/{id}/versions/{version}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    params: Schemas.updatePromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updatePromptVersion.body,
        },
      },
    },
  },
  responses: {
    ...validatedProtectedRouteErrors,
    200: {
      description: 'Prompt version updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePromptVersion.response,
        },
      },
    },
    ...promptVersionNotFound,
  },
});

const deletePromptVersion = createRoute({
  method: 'delete' as const,
  path: '/prompts/{id}/versions/{version}',
  security: bearerSecurity,
  middleware: [authorize({ scopes: [SCOPES.promptsWrite] })],
  request: {
    params: Schemas.deletePromptVersion.params,
  },
  responses: {
    ...validatedProtectedRouteErrors,
    204: {
      description: 'Prompt version deleted successfully',
    },
    ...promptVersionNotFound,
    409: {
      description: 'The version is the active one and cannot be deleted',
      content: jsonErrorContent,
    },
  },
});

export default {
  getPrompt,
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,

  getPromptVersion,
  listPromptVersions,
  createPromptVersion,
  updatePromptVersion,
  deletePromptVersion,
  renderPromptVersion,
};
