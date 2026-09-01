import { describe, expect, test } from 'bun:test';
import { createDatabaseDouble, failsWith, rows } from '../../index';

const TABLE_NAME = Symbol.for('drizzle:Name');

function table(name: string): object {
  return { [TABLE_NAME]: name };
}

async function execute<T>(query: PromiseLike<T>): Promise<T> {
  return await query;
}

describe('database boundary fake', () => {
  test('routes responses by operation and table rather than global call order', async () => {
    const { database, db } = createDatabaseDouble();
    const models = table('models');
    const auditLogs = table('audit_logs');

    database.respondTo('select', 'models', rows({ id: 'model-1' }));
    database.respondTo('insert', 'audit_logs', rows({ id: 'audit-1' }));

    await expect(execute(db.insert(auditLogs).values({ event: 'created' }).returning())).resolves.toEqual([
      { id: 'audit-1' },
    ]);
    await expect(execute(db.select().from(models).where({ organizationId: 'org-1' }))).resolves.toEqual([
      { id: 'model-1' },
    ]);

    expect(database.queries.map(({ operation, table: name }) => `${operation}:${name}`)).toEqual([
      'insert:audit_logs',
      'select:models',
    ]);
    expect(() => database.assertResponsesConsumed()).not.toThrow();
  });

  test('keeps each fluent query together and records transaction membership', async () => {
    const { database, db } = createDatabaseDouble();
    const apiKeys = table('api_keys');

    database.respondTo('update', 'api_keys', rows({ id: 'key-1' }));

    await db.transaction((tx: typeof db) =>
      tx.update(apiKeys).set({ name: 'renamed' }).where({ id: 'key-1' }).returning(),
    );

    expect(database.queries).toEqual([
      {
        operation: 'update',
        table: 'api_keys',
        transaction: 0,
        calls: [
          { method: 'update', args: [apiKeys] },
          { method: 'set', args: [{ name: 'renamed' }] },
          { method: 'where', args: [{ id: 'key-1' }] },
          { method: 'returning', args: [] },
        ],
      },
    ]);
    expect(database.transactions).toEqual([{ committed: true, rolledBack: false }]);
  });

  test('supports reusable defaults without weakening explicit one-shot responses', async () => {
    const { database, db } = createDatabaseDouble();
    const logs = table('logs');

    database.respondTo('insert', 'logs', failsWith(new Error('first write failed')));
    database.defaultResponse('insert', 'logs', rows({ id: 'log-fallback' }));

    await expect(execute(db.insert(logs).values({ status: 'incomplete' }))).rejects.toThrow('first write failed');
    await expect(execute(db.insert(logs).values({ status: 'incomplete' }))).resolves.toEqual([{ id: 'log-fallback' }]);
    await expect(execute(db.insert(logs).values({ status: 'incomplete' }))).resolves.toEqual([{ id: 'log-fallback' }]);
  });

  test('reports unused and exhausted route responses explicitly', async () => {
    const { database, db } = createDatabaseDouble();
    const models = table('models');

    database.respondTo('select', 'models', rows({ id: 'model-1' }));
    expect(() => database.assertResponsesConsumed()).toThrow('Unused database responses: select:models (1)');

    await db.select().from(models);
    expect(() => database.assertResponsesConsumed()).not.toThrow();
    await expect(execute(db.select().from(models))).rejects.toThrow('Database responses exhausted for select:models');
  });

  test('routes raw SQL explicitly and rejects an unconfigured route', async () => {
    const { database, db } = createDatabaseDouble();

    database.respondTo('execute', null, rows({ total: 3 }));

    await expect(db.execute('select count(*)')).resolves.toEqual([{ total: 3 }]);
    expect(database.queries[0]).toMatchObject({ operation: 'execute', table: null, transaction: null });
    expect(() => database.assertResponsesConsumed()).not.toThrow();

    database.reset();
    await expect(execute(db.select().from(table('organizations')))).rejects.toThrow(
      'Unconfigured database route select:organizations',
    );
  });
});
