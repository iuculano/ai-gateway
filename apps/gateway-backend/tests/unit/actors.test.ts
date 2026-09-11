import { beforeEach, expect, test } from 'bun:test';
import { database, forCaller, installModuleMocks, KEY_ID, resetDoubles, rows, USER_ID } from './doubles';

await installModuleMocks();
const Services = forCaller((await import('../../src/api/actors/actors.services')).default);
const { default: Schemas } = await import('../../src/api/actors/actors.schemas');
beforeEach(resetDoubles);

test('resolves users, API keys and system actors in input order, including duplicates', async () => {
  database.respondTo('select', 'users', rows({ id: USER_ID, name: 'Alex' }));
  database.respondTo('select', 'api_keys', rows({ id: KEY_ID, name: 'Deployment' }));
  const user = { actor_type: 'user' as const, actor_id: USER_ID };
  const result = await Services.resolveActors({
    actors: [user, { actor_type: 'api_key', actor_id: KEY_ID }, { actor_type: 'system', actor_id: null }, user],
  });
  expect(result.data.map((actor) => actor.display)).toEqual([
    { name: 'Alex' },
    { name: 'Deployment' },
    { name: 'System' },
    { name: 'Alex' },
  ]);
});

test('missing actors have null displays', async () => {
  database.respondTo('select', 'users', rows());
  database.respondTo('select', 'api_keys', rows());
  const result = await Services.resolveActors({
    actors: [
      { actor_type: 'user', actor_id: USER_ID },
      { actor_type: 'api_key', actor_id: KEY_ID },
    ],
  });
  expect(result.data.map((actor) => actor.display)).toEqual([null, null]);
});

test('empty batches and system actors resolve without database results', async () => {
  expect(await Services.resolveActors({ actors: [] })).toEqual({ data: [] });
  expect(await Services.resolveActors({ actors: [{ actor_type: 'system', actor_id: null }] })).toEqual({
    data: [{ actor_type: 'system', actor_id: null, display: { name: 'System' } }],
  });
});

test('validation accepts 250 references and rejects 251 or missing non-system IDs', () => {
  const actors = Array.from({ length: 250 }, () => ({ actor_type: 'user', actor_id: USER_ID }));
  expect(Schemas.resolveActors.body.safeParse({ actors }).success).toBe(true);
  expect(Schemas.resolveActors.body.safeParse({ actors: [...actors, actors[0]] }).success).toBe(false);
  for (const actor_type of ['user', 'api_key']) {
    expect(Schemas.resolveActors.body.safeParse({ actors: [{ actor_type, actor_id: null }] }).success).toBe(false);
  }
});
