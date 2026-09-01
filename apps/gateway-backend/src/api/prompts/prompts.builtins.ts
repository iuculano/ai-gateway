/**
 * How much a built-in's value moves between two otherwise identical renders.
 */
export type Stability = 'fixed' | 'daily' | 'instant';

/** Everything a built-in may read. Assembled once per render. */
export interface BuiltinContext {
  /** The instant the render started. */
  now: Date;

  /** The organization the request is running under. */
  organization: { id: string; name: string };

  /** The prompt being rendered, so a template can state which one it is. */
  prompt: { name: string; version: number };

  /** Correlation id for the request, when upstream middleware assigned one. */
  requestId: string | undefined;
}

/** Represents a built-in variable that can be used in prompts. */
export interface Builtin {
  /** Shown beside the name in the dashboard's variable list. */
  description: string;

  /** An example value, so the catalogue reads concretely. */
  example: string;

  /** The built-in's lifecycle/update pattern. */
  stability: Stability;

  /**
   * The value to substitute, or undefined when the context cannot supply one.
   *
   * Undefined leaves the tag unresolved rather than substituting a blank, the
   * same as a caller input that was never provided.
   */
  resolve: (context: BuiltinContext) => string | undefined;
}

function part(now: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(now);
}

// Don't know how I feel about having things like examples stored like this, but
// it's easy to hand off to the frontend...
export const BUILTINS = {
  // Clock
  //
  // All UTC, always. A gateway has no reliable notion of the caller's zone -
  // the request carries none - so a "local" time here would silently be the
  // server's, which is worse than a stated UTC.

  'aig.date': {
    description: "Today's date in UTC, as YYYY-MM-DD",
    example: '2026-08-18',
    stability: 'daily',
    resolve: ({ now }) => now.toISOString().slice(0, 10),
  },

  'aig.time': {
    description: 'The current UTC time, as HH:MM:SS',
    example: '21:14:07',
    stability: 'instant',
    resolve: ({ now }) => now.toISOString().slice(11, 19),
  },

  'aig.datetime': {
    description: 'The current UTC instant, ISO 8601',
    example: '2026-08-18T21:14:07.482Z',
    stability: 'instant',
    resolve: ({ now }) => now.toISOString(),
  },

  'aig.timestamp': {
    description: 'Seconds since the Unix epoch',
    example: '1786655647',
    stability: 'instant',
    resolve: ({ now }) => String(Math.floor(now.getTime() / 1000)),
  },

  'aig.year': {
    description: 'The current UTC year',
    example: '2026',
    stability: 'daily',
    resolve: ({ now }) => now.toISOString().slice(0, 4),
  },

  'aig.month': {
    description: 'The current UTC month, zero-padded',
    example: '08',
    stability: 'daily',
    resolve: ({ now }) => now.toISOString().slice(5, 7),
  },

  'aig.day': {
    description: 'The current UTC day of the month, zero-padded',
    example: '18',
    stability: 'daily',
    resolve: ({ now }) => now.toISOString().slice(8, 10),
  },

  'aig.weekday': {
    description: 'The current UTC day of the week, spelled out',
    example: 'Tuesday',
    stability: 'daily',
    resolve: ({ now }) => part(now, { weekday: 'long' }),
  },

  'aig.month_name': {
    description: 'The current UTC month, spelled out',
    example: 'August',
    stability: 'daily',
    resolve: ({ now }) => part(now, { month: 'long' }),
  },

  'aig.date_long': {
    description: "Today's date in UTC, written out",
    example: 'August 18, 2026',
    stability: 'daily',
    resolve: ({ now }) => part(now, { year: 'numeric', month: 'long', day: 'numeric' }),
  },

  'aig.organization_name': {
    description: 'The name of the organization the request is running under',
    example: 'Apollo Labs',
    stability: 'fixed',
    resolve: ({ organization }) => organization.name,
  },

  'aig.organization_id': {
    description: 'The id of the organization the request is running under',
    example: '019512aa-1111-7000-8000-000000000001',
    stability: 'fixed',
    resolve: ({ organization }) => organization.id,
  },

  'aig.prompt_name': {
    description: 'The name of the prompt being rendered',
    example: 'some-cool-prompt',
    stability: 'fixed',
    resolve: ({ prompt }) => prompt.name,
  },

  'aig.prompt_version': {
    description: 'The version of the prompt being rendered',
    example: '3',
    stability: 'fixed',
    resolve: ({ prompt }) => String(prompt.version),
  },

  // NOTE: Relies on middleware upstream.
  'aig.request_id': {
    description: 'The id correlating this render with its log entry',
    example: '01K2Q8ZC7YV3F9J4M6N8P0R2T4',
    stability: 'instant',
    resolve: ({ requestId }) => requestId,
  },

  'aig.uuid': {
    description: 'A fresh UUID, different on every render',
    example: '5f8c1d2e-9a3b-4c6d-8e0f-1a2b3c4d5e6f',
    stability: 'instant',
    resolve: () => globalThis.crypto.randomUUID(),
  },
} as const satisfies Record<string, Builtin>;

export type BuiltinName = keyof typeof BUILTINS;
export const BUILTIN_PREFIX = 'aig.';
export const BUILTIN_CATALOGUE: { name: string; description: string; example: string; stability: Stability }[] =
  Object.entries(BUILTINS).map(([name, builtin]) => ({
    name,
    description: builtin.description,
    example: builtin.example,
    stability: builtin.stability,
  }));

/**
 * Whether a tag name is reserved, whether or not it names a known built-in.
 *
 * @param name
 * The tag name to check.
 *
 * @returns
 * True if the name is reserved, false otherwise.
 */
export function isReserved(name: string): boolean {
  return name.startsWith(BUILTIN_PREFIX);
}

/**
 * Resolves a built-in.
 *
 * @returns
 * The value, or undefined when the name is not a built-in or the context
 * cannot supply one.
 */
export function resolveBuiltin(name: string, context: BuiltinContext): string | undefined {
  if (!isReserved(name)) {
    return undefined;
  }

  // Reached through Object.hasOwn rather than a bare lookup, so a tag named
  // `aig.constructor` finds nothing instead of Object's own property.
  if (!Object.hasOwn(BUILTINS, name)) {
    return undefined;
  }

  return BUILTINS[name as BuiltinName].resolve(context);
}
