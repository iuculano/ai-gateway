import { z } from '@hono/zod-openapi';
import { webhookDeliveries, webhookOutbox, webhooks } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/zod';

const webhookResponse = createSelectSchema(webhooks, {
  filter: z.record(z.string(), z.string()).nullable(),
  tags: z.record(z.string(), z.string()).nullable(),
}).omit({ organization_id: true });

const getWebhook = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: webhookResponse,
});

const listWebhooks = createSchema({
  query: z.object({
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional().default(50),
    after_id: z.uuidv7().optional(), // UUIDv7 cursor
  }),

  response: z.object({
    data: z.array(webhookResponse),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createWebhook = createSchema({
  body: createInsertSchema(webhooks)
    .omit({
      id: true, // server-generated
      organization_id: true, // supplied from the caller
      created_at: true, // server-generated
      updated_at: true, // server-generated
      creator_id: true, // supplied from the caller
    })
    .extend({
      filter: z.record(z.string(), z.string()).nullish(),
      tags: z.record(z.string(), z.string()).nullish(),
    }),

  response: webhookResponse,
});

const updateWebhook = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: createUpdateSchema(webhooks)
    .omit({
      id: true, // server-generated
      organization_id: true, // supplied from the caller
      created_at: true, // server-generated
      updated_at: true, // server-generated
      creator_id: true, // supplied from the caller
    })
    .extend({
      filter: z.record(z.string(), z.string()).nullish(),
      tags: z.record(z.string(), z.string()).nullish(),
    }),

  response: webhookResponse,
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
    data: z.array(createSelectSchema(webhookOutbox)),
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
    data: z.array(createSelectSchema(webhookDeliveries)),
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
