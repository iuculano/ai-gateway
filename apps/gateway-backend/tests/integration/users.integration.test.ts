import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { resolveUser } from '@repo/auth';
import { admin, prepareSuite, resetDatabase } from './setup';

beforeAll(prepareSuite);
beforeEach(resetDatabase);

const profile = {
  username: 'alex',
  email: 'alex@example.test',
  name: 'Alex',
};

test('the same issuer and subject resolve to one stable user', async () => {
  const first = await resolveUser('https://idp-a.example', 'subject-1', profile);
  const second = await resolveUser('https://idp-a.example', 'subject-1', profile);

  expect(second).toBe(first);
});

test('equal subjects from different issuers resolve to different users', async () => {
  const first = await resolveUser('https://idp-a.example', 'shared-subject', profile);
  const second = await resolveUser('https://idp-b.example', 'shared-subject', profile);

  expect(second).not.toBe(first);
});

test('concurrent first logins converge on one user', async () => {
  const ids = await Promise.all([
    resolveUser('https://idp-a.example', 'racing-subject', profile),
    resolveUser('https://idp-a.example', 'racing-subject', profile),
  ]);

  expect(new Set(ids).size).toBe(1);

  const [count] = await admin`
    select count(*)::int as value
    from user_identities
    where external_idp = 'https://idp-a.example' and external_id = 'racing-subject'
  `;
  expect(count?.value).toBe(1);
});

test('deleting a previously resolved user takes effect immediately', async () => {
  const id = await resolveUser('https://idp-a.example', 'subject-1', profile);

  await admin`update users set status = 'deleted' where id = ${id}`;

  await expect(resolveUser('https://idp-a.example', 'subject-1', profile)).rejects.toMatchObject({ status: 403 });
});

test('a legacy external_id is claimed without changing the local user id', async () => {
  const [legacy] = await admin`
    insert into users (username, email, external_id)
    values ('legacy', 'legacy@example.test', 'legacy-subject')
    returning id
  `;

  const resolved = await resolveUser('https://idp-a.example', 'legacy-subject', profile);

  expect(resolved).toBe(legacy?.id);

  const [user] = await admin`select external_id from users where id = ${resolved}`;
  const [identity] = await admin`
    select external_idp, external_id
    from user_identities
    where user_id = ${resolved}
  `;

  expect(user?.external_id).toBeNull();
  expect(identity).toMatchObject({
    external_idp: 'https://idp-a.example',
    external_id: 'legacy-subject',
  });
});
