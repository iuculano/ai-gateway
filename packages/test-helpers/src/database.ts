/**
 * A stand-in for Drizzle's fluent query builder.
 *
 * Shared because gateway-backend and @repo/auth had grown byte-identical copies
 * of it. Nothing here imports @repo/drizzle: the double answers any chain by
 * proxy, so it needs the shape of the builder rather than its types, and
 * staying dependency-free keeps this package off every other workspace's
 * dependency graph.
 */

/** One scripted answer to one database round trip. */
export type Step = { rows: unknown[] } | { error: Error };

/** A query that answers with these rows. Pass nothing for an empty result. */
export function rows(...values: unknown[]): Step {
  return { rows: values };
}

/** A query that rejects - the channel every unexpected failure travels down. */
export function failsWith(error: Error): Step {
  return { error };
}

export interface DatabaseDouble {
  steps: Step[];
  consumed: number;

  /** One entry per transaction opened, in order, recording how it ended. */
  transactions: { committed: boolean; rolledBack: boolean }[];

  /**
   * Every builder method the services called, with its arguments.
   *
   * What a query was ASKED to do, as opposed to what it was told in reply -
   * the only way to assert on the values a write actually carried.
   */
  calls: { method: string; args: unknown[] }[];

  /**
   * The answers this test's queries get, in the order they are issued.
   *
   * A query beyond the end of the script rejects rather than returning nothing:
   * an unscripted call is the test being wrong, and an empty result would read
   * as a deliberate "no rows" and quietly pass.
   */
  script(...steps: Step[]): void;

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
  const database: DatabaseDouble = {
    steps: [],
    consumed: 0,
    transactions: [],
    calls: [],

    script(...steps: Step[]) {
      database.steps = steps;
      database.consumed = 0;
      database.transactions = [];
      database.calls = [];
    },

    reset() {
      database.script();
    },
  };

  function nextRows(): Promise<unknown[]> {
    const step = database.steps[database.consumed++];

    if (!step) {
      return Promise.reject(new Error(`Unscripted database call (query ${database.consumed})`));
    }

    if ('error' in step) {
      return Promise.reject(step.error);
    }

    return Promise.resolve(step.rows);
  }

  /**
   * A query builder that accepts any chain and resolves to the next scripted
   * answer.
   *
   * Every method returns the builder itself, so .select().from().where() and
   * .update().set().where().returning() both work without naming them.
   */
  function queryBuilder(): unknown {
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
              nextRows().then(resolve, reject);
          }

          // Symbols are the runtime asking questions (Symbol.toStringTag and
          // friends), not the service calling a query method.
          if (typeof property === 'symbol') {
            return undefined;
          }

          return (...args: unknown[]) => {
            database.calls.push({ method: property, args });
            return builder;
          };
        },
      },
    );

    return builder;
  }

  // The entry point is recorded like any other link in the chain, so a test can
  // assert that a select happened at all and not only what was chained onto it.
  function startQuery(method: string, args: unknown[]): unknown {
    database.calls.push({ method, args });
    return queryBuilder();
  }

  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for drizzle's builder, which is not worth reproducing in types
  const db: any = {
    select: (...args: unknown[]) => startQuery('select', args),
    insert: (...args: unknown[]) => startQuery('insert', args),
    update: (...args: unknown[]) => startQuery('update', args),
    delete: (...args: unknown[]) => startQuery('delete', args),

    // Not chained - `execute` is the escape hatch for raw SQL, so it consumes a
    // scripted answer itself rather than returning a builder.
    execute: (...args: unknown[]) => {
      database.calls.push({ method: 'execute', args });
      return nextRows();
    },

    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      const record = { committed: false, rolledBack: false };
      database.transactions.push(record);

      try {
        const value = await callback(db);
        record.committed = true;
        return value;
      } catch (error) {
        record.rolledBack = true;
        throw error;
      }
    },
  };

  return { database, db };
}
