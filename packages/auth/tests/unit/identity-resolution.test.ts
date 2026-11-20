import { beforeEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import {
  database,
  failsWith,
  installAuthMocks,
  ORGANIZATION_ID,
  organizationRow,
  resetDoubles,
  rows,
  USER_ID,
  userRow,
} from './doubles';

await installAuthMocks();

const { getOrganization, resolveOrganization, getUserById, resolveUser } = await import('../../index');

beforeEach(resetDoubles);

async function rejectedHttpException(promise: Promise<unknown>): Promise<HTTPException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPException) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected the operation to reject with HTTPException');
}

describe('organizations', () => {
  test('gets a local organization without applying authentication status policy', async () => {
    database.respondTo('select', 'organizations', rows(organizationRow({ status: 'suspended' })), rows());

    await expect(getOrganization(ORGANIZATION_ID)).resolves.toEqual({
      id: ORGANIZATION_ID,
      name: 'Acme',
      status: 'suspended',
    });
    await expect(getOrganization('missing')).resolves.toBeNull();
  });

  test('resolves an existing active external organization for a known member', async () => {
    database.respondTo('select', 'organizations', rows(organizationRow({ member_id: USER_ID })));

    await expect(
      resolveOrganization('https://issuer.example', 'tenant-1', USER_ID, 'Ignored New Name'),
    ).resolves.toEqual({
      id: ORGANIZATION_ID,
      name: 'Acme',
      status: 'active',
    });
    expect(database.queries).toHaveLength(1);
  });

  test('records a user the organization has not seen before', async () => {
    database.respondTo('select', 'organizations', rows(organizationRow({ member_id: null })));
    database.respondTo('insert', 'organization_members', rows());

    await expect(resolveOrganization('https://issuer.example', 'tenant-1', USER_ID)).resolves.toMatchObject({
      id: ORGANIZATION_ID,
    });

    const insert = database.queriesFor('insert', 'organization_members')[0];
    expect(insert?.calls.find((call) => call.method === 'values')?.args[0]).toEqual({
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
    });
  });

  test('rejects when the member cannot be recorded', async () => {
    database.respondTo('select', 'organizations', rows(organizationRow({ member_id: null })));
    database.respondTo('insert', 'organization_members', failsWith(new Error('connection terminated')));

    await expect(resolveOrganization('https://issuer.example', 'tenant-1', USER_ID)).rejects.toThrow(
      'connection terminated',
    );
  });

  test('refuses a suspended external organization', async () => {
    database.respondTo('select', 'organizations', rows(organizationRow({ status: 'suspended' })));

    const error = await rejectedHttpException(resolveOrganization('https://issuer.example', 'tenant-1', USER_ID));

    expect(error.status).toBe(403);
    expect(error.cause).toBe('Organization is not active.');
  });

  test('provisions a missing organization with a deterministic collision-resistant slug', async () => {
    database.respondTo('select', 'organizations', rows());
    database.respondTo(
      'insert',
      'organizations',
      rows(
        organizationRow({
          external_id: 'Tenant #42',
          name: 'ACME / Dev',
          slug: 'acme-dev-tenant-42',
        }),
      ),
    );
    database.respondTo('insert', 'organization_members', rows());

    await expect(
      resolveOrganization('https://issuer.example', 'Tenant #42', USER_ID, 'ACME / Dev'),
    ).resolves.toMatchObject({
      id: ORGANIZATION_ID,
      name: 'ACME / Dev',
    });
    expect(database.queriesFor('insert', 'organization_members')).toHaveLength(1);

    const insert = database.queriesFor('insert', 'organizations')[0];
    const values = insert?.calls.find((call) => call.method === 'values')?.args[0];
    expect(values).toEqual({
      external_idp: 'https://issuer.example',
      external_id: 'Tenant #42',
      name: 'ACME / Dev',
      slug: 'acme-dev-tenant-42',
    });
  });

  test('recovers when another request wins concurrent organization provisioning', async () => {
    const conflict = new Error('unique constraint');
    database.respondTo('select', 'organizations', rows(), rows(organizationRow({ member_id: null })));
    database.respondTo('insert', 'organizations', failsWith(conflict));
    database.respondTo('insert', 'organization_members', rows());

    await expect(resolveOrganization('https://issuer.example', 'tenant-1', USER_ID)).resolves.toMatchObject({
      id: ORGANIZATION_ID,
    });
    expect(database.queries).toHaveLength(4);
  });

  test('surfaces organization provisioning failures when no concurrent row appeared', async () => {
    database.respondTo('select', 'organizations', rows(), rows());
    database.respondTo('insert', 'organizations', rows());

    await expect(resolveOrganization('https://issuer.example', 'tenant-1', USER_ID)).rejects.toThrow(
      'Failed to provision organization',
    );
    expect(database.queries).toHaveLength(3);
  });
});

describe('users', () => {
  test('gets a local user or returns null', async () => {
    database.respondTo('select', 'users', rows(userRow()), rows());

    await expect(getUserById(USER_ID)).resolves.toMatchObject({ id: USER_ID, username: 'alex' });
    await expect(getUserById('missing')).resolves.toBeNull();
  });

  test('resolves an existing active issuer-qualified identity without writing an unchanged profile', async () => {
    database.respondTo('select', 'user_identities', rows({ user: userRow() }));

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex Example',
      }),
    ).resolves.toBe(USER_ID);
    expect(database.queries).toHaveLength(1);
  });

  test('refreshes the stored profile when the identity provider reports a change', async () => {
    database.respondTo('select', 'user_identities', rows({ user: userRow() }));
    database.respondTo('update', 'users', rows());

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex Renamed',
      }),
    ).resolves.toBe(USER_ID);

    const update = database.queriesFor('update', 'users')[0];
    expect(update?.calls.find((call) => call.method === 'set')?.args[0]).toEqual({
      username: 'alex',
      email: 'alex@example.test',
      name: 'Alex Renamed',
    });
  });

  test('still resolves the user when the profile refresh fails', async () => {
    database.respondTo('select', 'user_identities', rows({ user: userRow() }));
    database.respondTo('update', 'users', failsWith(new Error('connection terminated')));

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'changed@example.test',
        name: 'Alex Example',
      }),
    ).resolves.toBe(USER_ID);
  });

  test('refuses a deleted external identity', async () => {
    database.respondTo('select', 'user_identities', rows({ user: userRow({ status: 'deleted' }) }));

    const error = await rejectedHttpException(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex',
      }),
    );

    expect(error.status).toBe(403);
    expect(error.cause).toBe('User is not active');
  });

  test('provisions the user and identity atomically on first sight', async () => {
    database.respondTo('select', 'user_identities', rows());
    database.respondTo('insert', 'users', rows({ id: USER_ID }));
    database.respondTo('insert', 'user_identities', rows());

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex Example',
      }),
    ).resolves.toBe(USER_ID);

    expect(database.transactions).toEqual([{ committed: true, rolledBack: false }]);
    const values = [...database.queriesFor('insert', 'users'), ...database.queriesFor('insert', 'user_identities')].map(
      (query) => query.calls.find((call) => call.method === 'values')?.args[0],
    );
    expect(values).toEqual([
      // The id is made here, with the user type in it.
      { id: expect.stringMatching(/1$/), username: 'alex', email: 'alex@example.test', name: 'Alex Example' },
      { user_id: USER_ID, external_idp: 'https://issuer.example', external_id: 'subject-1' },
    ]);
  });

  test('rolls back and resolves the winner of concurrent identity provisioning', async () => {
    database.respondTo('select', 'user_identities', rows(), rows({ user: userRow() }));
    database.respondTo('insert', 'users', rows({ id: USER_ID }));
    database.respondTo('insert', 'user_identities', failsWith(new Error('unique identity constraint')));

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex',
      }),
    ).resolves.toBe(USER_ID);
    expect(database.transactions).toEqual([{ committed: false, rolledBack: true }]);
  });

  test('surfaces provisioning failures when no concurrent identity appeared', async () => {
    database.respondTo('select', 'user_identities', rows(), rows());
    database.respondTo('insert', 'users', rows());

    await expect(
      resolveUser('https://issuer.example', 'subject-1', {
        username: 'alex',
        email: 'alex@example.test',
        name: 'Alex',
      }),
    ).rejects.toThrow('Failed to provision user');
    expect(database.transactions).toEqual([{ committed: false, rolledBack: true }]);
  });
});
