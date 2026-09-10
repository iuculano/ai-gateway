import type { InferRequestType } from 'hono/client';
import { internalClient } from './client';

type ActorReference = InferRequestType<typeof internalClient.actors.resolve.$post>['json']['actors'][number];
type Actor = { actor_type: string | null; actor_id: string | null };

/** Resolve distinct actors in batches, then look up names without combining types and IDs. */
export async function resolveActorNames(actors: Actor[]) {
  const users = new Map<string, string>();
  const apiKeys = new Map<string, string>();
  const references: ActorReference[] = [];

  for (const actor of actors) {
    if (!actor.actor_id || (actor.actor_type !== 'user' && actor.actor_type !== 'api_key')) continue;
    const names = actor.actor_type === 'user' ? users : apiKeys;
    if (names.has(actor.actor_id)) continue;
    names.set(actor.actor_id, actor.actor_type === 'user' ? 'Unknown user' : 'Unknown API key');
    references.push({ actor_type: actor.actor_type, actor_id: actor.actor_id });
  }

  // The endpoint accepts at most 250 references per request.
  for (let offset = 0; offset < references.length; offset += 250) {
    const response = await internalClient.actors.resolve.$post({
      json: { actors: references.slice(offset, offset + 250) },
    });
    const { data } = await response.json();
    for (const actor of data) {
      if (!actor.actor_id || !actor.display) continue;
      const names = actor.actor_type === 'user' ? users : apiKeys;
      names.set(actor.actor_id, actor.display.name);
    }
  }

  return (actor: Actor): string => {
    if (actor.actor_type === 'system') return 'System';
    if (actor.actor_type === 'user') return users.get(actor.actor_id ?? '') ?? 'Unknown user';
    if (actor.actor_type === 'api_key') return apiKeys.get(actor.actor_id ?? '') ?? 'Unknown API key';
    return 'Unknown actor';
  };
}
