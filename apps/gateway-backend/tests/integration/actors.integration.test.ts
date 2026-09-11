import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { runWithCaller } from '@repo/hono';
import Services from '../../src/api/actors/actors.services';
import { admin, callerFor, prepareSuite, resetDatabase, seedTenant, type Tenant } from './setup';

let acme: Tenant;
let globex: Tenant;
beforeAll(prepareSuite);
beforeEach(async () => {
  await resetDatabase();
  acme = await seedTenant('acme');
  globex = await seedTenant('globex');
});

test('users resolve directly without organization activity and include tombstones', async () => {
  const resolve = () =>
    runWithCaller(callerFor(acme), () =>
      Services.resolveActors({
        actors: [
          { actor_type: 'user', actor_id: acme.userId },
          { actor_type: 'user', actor_id: globex.userId },
        ],
      }),
    );
  expect((await resolve()).data.map((actor) => actor.display)).toEqual([
    { name: 'acme-user' },
    { name: 'globex-user' },
  ]);
  await admin`update users set status = 'deleted' where id = ${globex.userId}`;
  expect((await resolve()).data[1]?.display).toEqual({ name: 'globex-user' });
});

test('API key names remain available after revocation but never across tenants', async () => {
  const [key] = await admin`insert into api_keys (organization_id, name, key_hash, creator_id, revoked_at)
    values (${acme.organizationId}, 'Deployment', ${'a'.repeat(64)}, ${globex.userId}, now()) returning id`;
  if (!key) throw new Error('Failed to seed API key');
  const actors = [{ actor_type: 'api_key' as const, actor_id: key.id }];
  const own = await runWithCaller(callerFor(acme), () => Services.resolveActors({ actors }));
  expect(own.data[0]?.display).toEqual({ name: 'Deployment' });
  const foreign = await runWithCaller(callerFor(globex), () => Services.resolveActors({ actors }));
  expect(foreign.data[0]?.display).toBeNull();
});

test('the actor type selects the table even when a user and key share an ID', async () => {
  await admin`insert into api_keys (id, organization_id, name, key_hash, creator_id)
    values (${acme.userId}, ${acme.organizationId}, 'Deployment', ${'b'.repeat(64)}, ${globex.userId})`;
  const result = await runWithCaller(callerFor(acme), () =>
    Services.resolveActors({
      actors: [
        { actor_type: 'user', actor_id: acme.userId },
        { actor_type: 'api_key', actor_id: acme.userId },
        { actor_type: 'api_key', actor_id: globex.userId },
      ],
    }),
  );
  expect(result.data.map((actor) => actor.display)).toEqual([{ name: 'acme-user' }, { name: 'Deployment' }, null]);
});
