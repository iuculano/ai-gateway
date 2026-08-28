/**
 * A stand-in for Drizzle's fluent query builder.
 *
 * Shared because gateway-backend and @repo/auth had grown byte-identical copies
 * of it. Nothing here imports @repo/drizzle: the double answers any chain by
 * proxy, so it needs the shape of the builder rather than its types, and
 * staying dependency-free keeps this package off every other workspace's
 * dependency graph.
 */

/** One arranged answer to one database round trip. */
export type DatabaseResponse = { rows: unknown[] } | { error: Error };

export type DatabaseOperation = 'select' | 'insert' | 'update' | 'delete' | 'execute';

export interface DatabaseQueryCall {
  method: string;
  args: unknown[];
}

/**
 * One complete query observed at the database boundary.
 *
 * This keeps a fluent Drizzle chain together and records whether it ran inside
 * a transaction. Tests can ask what was written to one table without
 * reconstructing query order globally.
 */
export interface DatabaseQuery {
  operation: DatabaseOperation;
  table: string | null;
  calls: DatabaseQueryCall[];
  transaction: number | null;
}

export type DatabaseResponder = DatabaseResponse | ((query: DatabaseQuery) => DatabaseResponse);

/** A query that answers with these rows. Pass nothing for an empty result. */
export function rows(...values: unknown[]): DatabaseResponse {
  return { rows: values };
}

/** A query that rejects - the channel every unexpected failure travels down. */
export function failsWith(error: Error): DatabaseResponse {
  return { error };
}

export interface DatabaseDouble {
  /** One entry per transaction opened, in order, recording how it ended. */
  transactions: { committed: boolean; rolledBack: boolean }[];

  /** Complete fluent queries, grouped and classified by operation and table. */
  queries: DatabaseQuery[];

  /** Returns the observed queries at one database route, in execution order. */
  queriesFor(operation: DatabaseOperation, table: string | null): DatabaseQuery[];

  /**
   * Answers queries by intent instead of global execution order.
   *
   * Multiple responders form a queue only for this operation/table pair. A
   * second query cannot accidentally consume another table's answer.
   */
  respondTo(operation: DatabaseOperation, table: string | null, ...responders: DatabaseResponder[]): void;

  /**
   * Provides a reusable response after any explicit responders for this route.
   * Shared harnesses use this for incidental boundary work such as audit rows.
   */
  defaultResponse(operation: DatabaseOperation, table: string | null, responder: DatabaseResponder): void;

  /** Throws when a configured one-shot response was never exercised. */
  assertResponsesConsumed(): void;

  reset(): void;
}

export interface DatabaseDoubleHandle {
  database: DatabaseDouble;

  /**
   * What to hand `@repo/drizzle` in place of its real `db`.
   *
   * Typed loosely on purpose: reproducing Drizzle's builder types adds no test
   * value, and every caller passes this straight into mock.module.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for drizzle's builder, which is not worth reproducing in types
  db: any;
}

/**
 * One independent double per call.
 *
 * A factory rather than a module-level singleton so a workspace's own
 * doubles.ts owns the instance its tests reach for, and importing this package
 * never quietly shares mutable state between two suites.
 */
export function createDatabaseDouble(): DatabaseDoubleHandle {
  interface ResponseRoute {
    operation: DatabaseOperation;
    table: string | null;
    responders: DatabaseResponder[];
    consumed: number;
    fallback?: DatabaseResponder;
  }

  const routes = new Map<string, ResponseRoute>();

  function routeKey(operation: DatabaseOperation, table: string | null): string {
    return `${operation}:${table ?? '<raw>'}`;
  }

  const database: DatabaseDouble = {
    transactions: [],
    queries: [],

    queriesFor(operation, table) {
      return database.queries.filter((query) => query.operation === operation && query.table === table);
    },

    respondTo(operation, table, ...responders) {
      if (responders.length === 0) {
        throw new Error(`No database responses configured for ${routeKey(operation, table)}`);
      }

      const key = routeKey(operation, table);
      const existing = routes.get(key);
      routes.set(key, {
        operation,
        table,
        responders: existing ? [...existing.responders, ...responders] : responders,
        consumed: existing?.consumed ?? 0,
        fallback: existing?.fallback,
      });
    },

    defaultResponse(operation, table, responder) {
      const key = routeKey(operation, table);
      const existing = routes.get(key);
      routes.set(key, {
        operation,
        table,
        responders: existing?.responders ?? [],
        consumed: existing?.consumed ?? 0,
        fallback: responder,
      });
    },

    assertResponsesConsumed() {
      const pending = [...routes.values()].flatMap((route) => {
        const remaining = route.responders.length - route.consumed;
        return remaining > 0 ? [`${routeKey(route.operation, route.table)} (${remaining})`] : [];
      });

      if (pending.length > 0) {
        throw new Error(`Unused database responses: ${pending.join(', ')}`);
      }
    },

    reset() {
      routes.clear();
      database.transactions = [];
      database.queries = [];
    },
  };

  function resolveResponder(responder: DatabaseResponder, query: DatabaseQuery): Promise<unknown[]> {
    const step = typeof responder === 'function' ? responder(query) : responder;

    if ('error' in step) {
      return Promise.reject(step.error);
    }

    return Promise.resolve(step.rows);
  }

  function answer(query: DatabaseQuery): Promise<unknown[]> {
    database.queries.push(query);

    const route = routes.get(routeKey(query.operation, query.table));
    if (!route) {
      return Promise.reject(new Error(`Unconfigured database route ${routeKey(query.operation, query.table)}`));
    }

    const responder = route.responders[route.consumed];
    if (responder !== undefined) {
      route.consumed += 1;
      return resolveResponder(responder, query);
    }

    if (route.fallback !== undefined) {
      return resolveResponder(route.fallback, query);
    }

    return Promise.reject(new Error(`Database responses exhausted for ${routeKey(query.operation, query.table)}`));
  }

  const TABLE_NAME = Symbol.for('drizzle:Name');

  function tableName(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const name = (value as Record<symbol, unknown>)[TABLE_NAME];
    return typeof name === 'string' ? name : null;
  }

  let activeTransaction: number | null = null;

  /**
   * A query builder that accepts any chain and resolves through the response
   * arranged for its operation and table.
   *
   * Every method returns the builder itself, so .select().from().where() and
   * .update().set().where().returning() both work without naming them.
   */
  function queryBuilder(operation: Exclude<DatabaseOperation, 'execute'>, rootArgs: unknown[]): unknown {
    const query: DatabaseQuery = {
      operation,
      table: operation === 'select' ? null : tableName(rootArgs[0]),
      calls: [{ method: operation, args: rootArgs }],
      transaction: activeTransaction,
    };

    const builder: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
              answer(query).then(resolve, reject);
          }

          // Symbols are the runtime asking questions (Symbol.toStringTag and
          // friends), not the service calling a query method.
          if (typeof property === 'symbol') {
            return undefined;
          }

          return (...args: unknown[]) => {
            query.calls.push({ method: property, args });
            if (property === 'from') {
              query.table = tableName(args[0]);
            }
            return builder;
          };
        },
      },
    );

    return builder;
  }

  function startQuery(operation: Exclude<DatabaseOperation, 'execute'>, args: unknown[]): unknown {
    return queryBuilder(operation, args);
  }

  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for drizzle's builder, which is not worth reproducing in types
  const db: any = {
    select: (...args: unknown[]) => startQuery('select', args),
    insert: (...args: unknown[]) => startQuery('insert', args),
    update: (...args: unknown[]) => startQuery('update', args),
    delete: (...args: unknown[]) => startQuery('delete', args),

    // Not chained - `execute` is the escape hatch for raw SQL, so it consumes an
    // arranged answer itself rather than returning a builder.
    execute: (...args: unknown[]) => {
      return answer({
        operation: 'execute',
        table: null,
        calls: [{ method: 'execute', args }],
        transaction: activeTransaction,
      });
    },

    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      const record = { committed: false, rolledBack: false };
      database.transactions.push(record);
      const previousTransaction = activeTransaction;
      activeTransaction = database.transactions.length - 1;

      try {
        const value = await callback(db);
        record.committed = true;
        return value;
      } catch (error) {
        record.rolledBack = true;
        throw error;
      } finally {
        activeTransaction = previousTransaction;
      }
    },
  };

  return { database, db };
}
