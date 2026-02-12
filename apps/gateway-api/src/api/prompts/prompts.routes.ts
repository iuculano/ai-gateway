import { createRoute } from '@hono/zod-openapi';
import Schemas from './prompts.schemas';


const getPrompt = createRoute({
  method: 'get' as const,
  path: '/prompts/:id',
  request: {
    params: Schemas.getPrompt.params,
  },
  responses: {
    200: {
      description: 'Prompt retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPrompt.response,
        },
      },
    },
  },
});

const listPrompts = createRoute({
  method: 'get' as const,
  path: '/prompts',
  request: {
    query: Schemas.listPrompts.query,
  },
  responses: {
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

const createPrompt = createRoute({
  method: 'post' as const,
  path: '/prompts',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPrompt.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Prompt created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPrompt.response,
        },
      },
    },
  },
});

const updatePrompt = createRoute({
  method: 'patch' as const,
  path: '/prompts/:id',
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
    200: {
      description: 'Prompt updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePrompt.response,
        },
      },
    },
  },
});

const deletePrompt = createRoute({
  method: 'delete' as const,
  path: '/prompts/:id',
  request: {
    params: Schemas.deletePrompt.params,
  },
  responses: {
    204: {
      description: 'Prompt deleted successfully',
    },
  },
});

// ---

const getPromptVersion = createRoute({
  method: 'get' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.getPromptVersion.params,
  },
  responses: {
    200: {
      description: 'Prompt version retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.getPromptVersion.response,
        },
      },
    },
  },
});

const listPromptVersions = createRoute({
  method: 'get' as const,
  path: '/prompts/:id/versions',
  request: {
    params: Schemas.listPromptVersions.params,
    query: Schemas.listPromptVersions.query,
  },
  responses: {
    200: {
      description: 'Prompt versions retrieved successfully',
      content: {
        'application/json': {
          schema: Schemas.listPromptVersions.response,
        },
      },
    },
  },
});

const createPromptVersion = createRoute({
  method: 'post' as const,
  path: '/prompts/:id/versions',
  request: {
    params: Schemas.createPromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.createPromptVersion.body,
        },
      },
    }
  },
  responses: {
    201: {
      description: 'Prompt version created successfully',
      content: {
        'application/json': {
          schema: Schemas.createPromptVersion.response,
        },
      },
    },
  },
});

const updatePromptVersion = createRoute({
  method: 'patch' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.updatePromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.updatePromptVersion.body,
        },
      },
    }
  },
  responses: {
    200: {
      description: 'Prompt version updated successfully',
      content: {
        'application/json': {
          schema: Schemas.updatePromptVersion.response,
        },
      },
    },
  },
});

const deletePromptVersion = createRoute({
  method: 'delete' as const,
  path: '/prompts/:id/versions/:version',
  request: {
    params: Schemas.deletePromptVersion.params,
  },
  responses: {
    204: {
      description: 'Prompt version deleted successfully',
    },
  },
});

const renderPromptVersion = createRoute({
  method: 'post' as const,
  path: '/prompts/:id/versions/:version/render',
  request: {
    params: Schemas.renderPromptVersion.params,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: Schemas.renderPromptVersion.body,
        },
      },
    }
  },
  responses: {
    200: {
      description: 'Prompt version rendered successfully',
      content: {
        'application/json': {
          schema: Schemas.renderPromptVersion.response,
        },
      },
    },
  },
});
//
//const updatePromptVersion = createRoute({
//  method: 'patch' as const,
//  path: '/prompts/:id/versions/:version',
//  request: {
//    params: Schemas.updatePromptVersionRequest,
//    body: {
//      required: true,
//      content: {
//        'application/json': {
//          schema: Schemas.updatePromptRequest,
//        },
//      },
//    },
//  },
//  responses: {
//    200: {
//      description: 'Prompt version updated successfully',
//      content: {
//        'application/json': {
//          schema: Schemas.updatePromptVersionResponse,
//        },
//      },
//    },
//  },
//});
//
//const deletePromptVersion = createRoute({
//  method: 'delete' as const,
//  path: '/prompts/:id/versions/:version',
//  request: {
//    params: Schemas.getPromptRequest,
//    body: {
//      required: true,
//      content: {
//        'application/json': {
//          schema: Schemas.deletePromptRequest,
//        },
//      },
//    },
//  },
//  responses: {
//    204: {
//      description: 'Prompt deleted successfully',
//    },
//  },
//});

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
}
