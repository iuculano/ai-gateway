import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const webhookShape = z.object({
  id: z.uuidv7(),
  name: z.string(),
  // The three nullable columns. Each is written the same way for two separate
  // reasons, and both are load-bearing:
  //
  // .nullish() because the column is nullable, so a row without one comes back
  // from postgres as null. Declared .optional() alone, filter and tags rejected
  // that row outright - which made every read of a webhook created without them
  // a 500, and that is the ordinary case rather than an edge one.
  //
  // .optional() outermost because a transform at the outside makes the KEY
  // required in the inferred input type. This shape is also the base for the
  // create and update bodies, so that would oblige a caller to pass
  // `filter: undefined` explicitly rather than just leaving it out.
  description: z
    .string()
    .nullish()
    .transform((x) => x ?? undefined)
    .optional(),
  endpoint: z.string(),
  filter: z
    .record(z.string(), z.string())
    .nullish()
    .transform((x) => x ?? undefined)
    .optional(),
  tags: z
    .record(z.string(), z.string())
    .nullish()
    .transform((x) => x ?? undefined)
    .optional(),
  created_at: z.date().transform((date) => date.toISOString()),
  updated_at: z.date().transform((date) => date.toISOString()),
});

const getWebhook = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: webhookShape,
});

const listWebhooks = createSchema({
  query: z.object({
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(webhookShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createWebhook = createSchema({
  body: webhookShape.omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: webhookShape,
});

const updateWebhook = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: webhookShape.partial().omit({
    id: true,
    created_at: true,
    updated_at: true,
  }),

  response: webhookShape,
});

const deleteWebhook = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

//---

const listWebhookOutbox = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(
      z.object({
        id: z.uuidv7(),
        webhook_id: z.uuidv7(),
        log_id: z.uuidv7(),
        created_at: z.date().transform((date) => date.toISOString()),
      }),
    ),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const listWebhookDeliveries = createSchema({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(
      z.object({
        id: z.uuidv7(),
        outbox_id: z.uuidv7(),
        webhook_id: z.uuidv7(),
        status_code: z.coerce.number().int(),
        created_at: z.date().transform((date) => date.toISOString()),
      }),
    ),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

export type GetWebhookParams = z.infer<typeof getWebhook.params>;
export type GetWebhookResponse = z.infer<typeof getWebhook.response>;
export type ListWebhooksQuery = z.infer<typeof listWebhooks.query>;
export type ListWebhooksResponse = z.infer<typeof listWebhooks.response>;
export type CreateWebhookBody = z.infer<typeof createWebhook.body>;
export type CreateWebhookResponse = z.infer<typeof createWebhook.response>;
export type UpdateWebhookBody = z.infer<typeof updateWebhook.body>;
export type UpdateWebhookResponse = z.infer<typeof updateWebhook.response>;
export type DeleteWebhookParams = z.infer<typeof deleteWebhook.params>;
export type DeleteWebhookResponse = z.infer<typeof deleteWebhook.response>;

export type ListWebhookOutboxQuery = z.infer<typeof listWebhookOutbox.query>;
export type ListWebhookOutboxResponse = z.infer<typeof listWebhookOutbox.response>;
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveries.query>;
export type ListWebhookDeliveriesResponse = z.infer<typeof listWebhookDeliveries.response>;

export default {
  getWebhook,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,

  listWebhookOutbox,
  listWebhookDeliveries,
};
