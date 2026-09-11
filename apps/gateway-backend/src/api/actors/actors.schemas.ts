import { z } from '@hono/zod-openapi';
import { createSchema } from '@repo/hono';

const actorReference = z.discriminatedUnion('actor_type', [
  z.object({ actor_type: z.literal('user'), actor_id: z.uuid() }),
  z.object({ actor_type: z.literal('api_key'), actor_id: z.uuid() }),
  z.object({ actor_type: z.literal('system'), actor_id: z.uuid().nullable() }),
]);

const resolveActors = createSchema({
  body: z.object({ actors: z.array(actorReference).max(250) }),
  response: z.object({
    data: z.array(
      z.object({
        actor_type: z.enum(['user', 'api_key', 'system']),
        actor_id: z.uuid().nullable(),
        display: z.object({ name: z.string() }).nullable(),
      }),
    ),
  }),
});

export type ResolveActorsBody = z.infer<typeof resolveActors.body>;
export type ResolveActorsResponse = z.infer<typeof resolveActors.response>;

export default {
  resolveActors,
};
