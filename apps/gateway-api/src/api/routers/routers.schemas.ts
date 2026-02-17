import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';


export const routerShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  description: z.string().optional(),
  active_version: z.number().nullable().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getRouter = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: routerShape,
});

const listRouters = createSchema({
  query: z.object({
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(routerShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean()
    })
  }),
});

const createRouter = createSchema({
  body: routerShape.omit({
    id: true,
    active_version: true, // No version can exist yet
    created_at: true,
    updated_at: true,
  }),

  response: routerShape,
});

const updateRouter = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: routerShape.partial().omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: routerShape,
});

const deleteRouter = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

//---

const baseRule = z.object({
  name: z.string(),
  outputs: z.record(z.string(), z.string()), // basically, condition -> target
});

// One schema per type
const startRule = baseRule.extend({
  type: z.literal('start'),
});

const endRule = baseRule.extend({
  type: z.literal('end'),
});

const operators = [
  'exists',
  'not_exists',
  'equals',
  'not_equals',
  'greater',
  'less',
  'greater_equal',
  'less_equal'
] as const;

const conditionRule = baseRule.extend({
  type: z.literal("condition"),
  inputs: z.record(z.string(), z.record(
    z.enum(operators),
    z.union([z.string(), z.number(), z.boolean()]),
  )), // basically: value: { operator:  expected }
});

// Can technically probably just make this a part of condtions...
const rateLimitRule = baseRule.extend({
  type: z.literal("rate_limit"),
  inputs: z.object({
    key: z.string(),
    limit: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
  }),
});

const weightedRule = baseRule.extend({
  type: z.literal("weighted"),
  configuration: z.object({
    choices: z.array(z.object({
      id: z.string(),
      weight: z.number().positive(),
    })).min(1),
  }),
});

const modelRule = baseRule.extend({
  type: z.literal('model'),
  inputs: z.object({
    provider: z.string(),
    model: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    max_retries: z.number().int().min(0).optional(),
  }),
  outputs: z.object({
    success: z.string(),
    failure: z.string().optional(),
  }),
});

const ruleShape = z.discriminatedUnion('type', [
  startRule,
  endRule,
  conditionRule,
  rateLimitRule,
  weightedRule,
  modelRule,
]);

const routerVersionShape = z.object({
  id: z.uuidv7(),
  router_id: z.uuidv7(),
  rules: z.array(ruleShape),
  version: z.coerce.number().positive(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getRouterVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  response: routerVersionShape,
});

const listRouterVersions = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(routerVersionShape.omit({
      rules: true,
    })),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean()
    }),
  }),
});

const createRouterVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: z.object({
    rules: z.array(ruleShape),
  }),

  response: routerVersionShape,
});

const updateRouterVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  body: z.object({
    rules: z.array(ruleShape),
  }),

  response: routerVersionShape,
});

const deleteRouterVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().positive(),
  }),

  response: z.void(),
});

export type RuleShape = z.infer<typeof ruleShape>;

export type GetRouterParams = z.infer<typeof getRouter.params>;
export type GetRouterResponse = z.infer<typeof getRouter.response>;
export type ListRoutersQuery = z.infer<typeof listRouters.query>;
export type ListRoutersResponse = z.infer<typeof listRouters.response>;
export type CreateRouterBody = z.infer<typeof createRouter.body>;
export type CreateRouterResponse = z.infer<typeof createRouter.response>;
export type UpdateRouterParams = z.infer<typeof updateRouter.params>;
export type UpdateRouterBody =  z.infer<typeof updateRouter.body>;
export type UpdateRouterResponse = z.infer<typeof updateRouter.response>;
export type DeleteRouterParams = z.infer<typeof deleteRouter.params>;
export type DeleteRouterResponse = z.infer<typeof deleteRouter.response>;

export type GetRouterVersionParams = z.infer<typeof getRouterVersion.params>;
export type GetRouterVersionResponse = z.infer<typeof getRouterVersion.response>;
export type ListRouterVersionsQuery = z.infer<typeof listRouterVersions.query>;
export type ListRouterVersionsResponse = z.infer<typeof listRouterVersions.response>;
export type CreateRouterVersionBody = z.infer<typeof createRouterVersion.body>;
export type CreateRouterVersionResponse = z.infer<typeof createRouterVersion.response>;
export type UpdateRouterVersionParams = z.infer<typeof updateRouterVersion.params>;
export type UpdateRouterVersionBody =  z.infer<typeof updateRouterVersion.body>;
export type UpdateRouterVersionResponse = z.infer<typeof updateRouterVersion.response>;
export type DeleteRouterVersionParams = z.infer<typeof deleteRouterVersion.params>;
export type DeleteRouterVersionResponse = z.infer<typeof deleteRouterVersion.response>;

export default {
  getRouter,
  listRouters,
  createRouter,
  updateRouter,
  deleteRouter,

  getRouterVersion,
  listRouterVersions,
  createRouterVersion,
  updateRouterVersion,
  deleteRouterVersion,
}
