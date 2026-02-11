import { createRoute } from '@hono/zod-openapi';
import Schemas from './prompts.schemas';


const getPrompt = createRoute({
  method: 'get' as const,
  path: '/prompts/:id',
  request: {
    params: Schemas.getPromptParams,
  },
  responses: {
    200: {
      description: 'Prompt retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPromptResponse,
        },
      },
    },
  },
});

const listPrompts = createRoute({
  method: 'get' as const,
  path: '/prompts',
  request: {
    query: Schemas.listPromptsQuery,
  },
  responses: {
    200: {
      description: 'Prompts retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listPromptsResponse,
        },
      },
    },
  },
});

const createPrompt = createRoute({
  method: 'post' as const,
  path: '/prompts',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPromptBody,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Prompt created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPromptResponse,
        },
      },
    },
  },
});

const updatePrompt = createRoute({
  method: 'patch' as const,
  path: '/prompts/:id',
  request: {
    params: Schemas.updatePromptParams,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updatePromptBody,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Prompt updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePromptResponse,
        },
      },
    },
  },
});

const deletePrompt = createRoute({
  method: 'delete' as const,
  path: '/prompts/:id',
  request: {
    params: Schemas.deletePromptParams,
  },
  responses: {
    204: {
      description: 'Prompt deleted successfully',
    },
  },
});

const renderPrompt = createRoute({
  method: 'post' as const,
  path: '/prompts/:id/render',
  request: {
    params: Schemas.renderPromptParams,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.renderPromptBody,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Prompt rendered successfully',
      content: {
        'application/json': {
          schema: Schemas.renderPromptResponse,
        },
      },
    },
  },
});

// ---

const getPromptVersion = createRoute({
  method: 'get' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.getPromptVersionRequest,
  },
  responses: {
    200: {
      description: 'Prompt version retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPromptVersionResponse,
        },
      },
    },
  },
});

  const listPromptVersions = createRoute({
  method: 'get' as const,
  path: '/prompts/:id/versions',
  request: {
    query: Schemas.listPromptVersionsRequest,
  },
  responses: {
    200: {
      description: 'Prompt versions retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listPromptVersionsResponse,
        },
      },
    },
  },
});

const createPromptVersion = createRoute({
  method: 'post' as const,
  path: '/prompts/:id/versions',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPromptVersionRequest,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Prompt version created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPromptVersionResponse,
        },
      },
    },
  },
});

const updatePromptVersion = createRoute({
  method: 'patch' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.updatePromptVersionRequest,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updatePromptRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Prompt version updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePromptVersionResponse,
        },
      },
    },
  },
});

const deletePromptVersion = createRoute({
  method: 'delete' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.getPromptRequest,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.deletePromptRequest,
        },
      },
    },
  },
  responses: {
    204: {
      description: 'Prompt deleted successfully',
    },
  },
});

export default {
  getPrompt,
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  renderPrompt,

  getPromptVersion,
  listPromptVersions,
  createPromptVersion,
  updatePromptVersion,
  deletePromptVersion,
}
