import { z } from '@hono/zod-openapi';
import { prompts, promptVersions } from '@repo/drizzle/schemas';
import { createSchema } from '@repo/hono';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/zod';

/**
 * A prompt as callers see it.
 *
 * `organization_id` is omitted rather than returned: the caller is already
 * scoped to one organization, so echoing it back says nothing they did not
 * supply and puts a tenancy identifier on the wire for no reason.
 */
const promptShape = createSelectSchema(prompts)
  .omit({
    organization_id: true,
  })
  .extend({
    // The column is jsonb typed as Record<string, string> in the schema;
    // stated here so the OpenAPI document says so too rather than "object".
    tags: z.record(z.string(), z.string()).nullish(),
  });

const promptVersionShape = createSelectSchema(promptVersions);

// Columns the caller never supplies, on either write path.
const serverOwnedColumns = {
  id: true, // server-generated
  organization_id: true, // supplied from the caller
  creator_id: true, // supplied from the caller
  created_at: true, // server-generated
  updated_at: true, // server-generated
} as const;

const getPrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: promptShape,
});

const listPrompts = createSchema({
  query: z.object({
    tags: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    data: z.array(promptShape),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createPrompt = createSchema({
  body: createInsertSchema(prompts)
    .omit({
      ...serverOwnedColumns,

      // No version exists yet, so there is nothing to point at.
      active_version: true,
    })
    .extend({
      name: z.string().min(1),
      tags: z.record(z.string(), z.string()).optional(),
    }),

  response: promptShape,
});

const updatePrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  body: createUpdateSchema(prompts)
    .omit(serverOwnedColumns)
    .extend({
      name: z.string().min(1).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),

  response: promptShape,
});

const deletePrompt = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  response: z.void(),
});

//---

const getPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),

    // Coerced because a path segment is a string. Versions are 1-based, so
    // anything under 1 is rejected at the boundary rather than looked up.
    version: z.coerce.number().int().positive(),
  }),

  response: promptVersionShape,
});

const listPromptVersions = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  query: z.object({
    limit: z.coerce.number().int().min(1).max(250).optional().default(25),
    after_id: z.uuidv7().optional(),
  }),

  response: z.object({
    // The prompt text is omitted from the listing on purpose: a page of 250
    // versions is a page of 250 full prompt bodies otherwise. Callers that
    // want the text fetch the one version they care about.
    data: z.array(promptVersionShape.omit({ prompt: true })),
    meta: z.object({
      oldest_id: z.uuidv7().nullable(),
      more_data: z.boolean(),
    }),
  }),
});

const createPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
  }),

  // `version` is absent deliberately - the server computes the next ordinal.
  // See createPromptVersion() in the service.
  body: z.object({
    prompt: z.string().min(1),
  }),

  response: promptVersionShape,
});

const updatePromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().int().positive(),
  }),

  body: z.object({
    prompt: z.string().min(1).optional(),
  }),

  response: promptVersionShape,
});

const deletePromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().int().positive(),
  }),

  response: z.void(),
});

const renderPromptVersion = createSchema({
  params: z.object({
    id: z.uuidv7(),
    version: z.coerce.number().int().positive(),
  }),

  body: z.object({
    inputs: z.record(z.string(), z.string()),
  }),

  response: z.object({
    prompt: z.string(),

    // Tags the template asked for that nothing could fill. Reported rather
    // than failed: a half-filled render is often what the caller wants to
    // see, and silently leaving the mustache in place tells them nothing.
    unresolved: z.array(z.string()),
  }),
});

export type GetPromptParams = z.infer<typeof getPrompt.params>;
export type GetPromptResponse = z.infer<typeof getPrompt.response>;
export type ListPromptsQuery = z.infer<typeof listPrompts.query>;
export type ListPromptsResponse = z.infer<typeof listPrompts.response>;
export type CreatePromptBody = z.infer<typeof createPrompt.body>;
export type CreatePromptResponse = z.infer<typeof createPrompt.response>;
export type UpdatePromptParams = z.infer<typeof updatePrompt.params>;
export type UpdatePromptBody = z.infer<typeof updatePrompt.body>;
export type UpdatePromptResponse = z.infer<typeof updatePrompt.response>;
export type DeletePromptParams = z.infer<typeof deletePrompt.params>;
export type DeletePromptResponse = z.infer<typeof deletePrompt.response>;

export type GetPromptVersionParams = z.infer<typeof getPromptVersion.params>;
export type GetPromptVersionResponse = z.infer<typeof getPromptVersion.response>;
export type ListPromptVersionsQuery = z.infer<typeof listPromptVersions.query>;
export type ListPromptVersionsResponse = z.infer<typeof listPromptVersions.response>;
export type CreatePromptVersionParams = z.infer<typeof createPromptVersion.params>;
export type CreatePromptVersionBody = z.infer<typeof createPromptVersion.body>;
export type CreatePromptVersionResponse = z.infer<typeof createPromptVersion.response>;
export type UpdatePromptVersionParams = z.infer<typeof updatePromptVersion.params>;
export type UpdatePromptVersionBody = z.infer<typeof updatePromptVersion.body>;
export type UpdatePromptVersionResponse = z.infer<typeof updatePromptVersion.response>;
export type DeletePromptVersionParams = z.infer<typeof deletePromptVersion.params>;
export type DeletePromptVersionResponse = z.infer<typeof deletePromptVersion.response>;
export type RenderPromptVersionParams = z.infer<typeof renderPromptVersion.params>;
export type RenderPromptVersionBody = z.infer<typeof renderPromptVersion.body>;
export type RenderPromptVersionResponse = z.infer<typeof renderPromptVersion.response>;

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
