import { beforeAll, beforeEach, expect, test } from 'bun:test';
import { resolveOrganization, resolveUser } from '@repo/auth';
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

test('a changed profile replaces the stored one on the next resolution', async () => {
  const id = await resolveUser('https://idp-a.example', 'subject-1', profile);
  const renamed = { username: 'alexandra', email: 'alexandra@example.test', name: 'Alexandra' };

  expect(await resolveUser('https://idp-a.example', 'subject-1', renamed)).toBe(id);

  const [row] = await admin`select username, email, name from users where id = ${id}`;
  expect(row).toEqual(renamed);
});

test('resolving an organization records its user as a member exactly once', async () => {
  const userId = await resolveUser('https://idp-a.example', 'subject-1', profile);

  const first = await resolveOrganization('https://idp-a.example', 'tenant-1', userId, 'Acme');
  const second = await resolveOrganization('https://idp-a.example', 'tenant-1', userId, 'Acme');

  expect(second.id).toBe(first.id);
  const members = await admin`select organization_id, user_id from organization_members`;
  expect(members).toEqual([{ organization_id: first.id, user_id: userId }]);
});

test('concurrent first logins to a new organization converge on one membership', async () => {
  const userId = await resolveUser('https://idp-a.example', 'subject-1', profile);

  const organizations = await Promise.all([
    resolveOrganization('https://idp-a.example', 'racing-tenant', userId),
    resolveOrganization('https://idp-a.example', 'racing-tenant', userId),
  ]);

  expect(new Set(organizations.map((organization) => organization.id)).size).toBe(1);
  const [count] = await admin`select count(*)::int as value from organization_members`;
  expect(count?.value).toBe(1);
});

test('deleting a previously resolved user takes effect immediately', async () => {
  const id = await resolveUser('https://idp-a.example', 'subject-1', profile);

  await admin`update users set status = 'deleted' where id = ${id}`;

  await expect(resolveUser('https://idp-a.example', 'subject-1', profile)).rejects.toMatchObject({ status: 403 });
});
