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

export const BUILTINS = {
  // Clock
  //
  // All UTC, always. A gateway has no reliable notion of the caller's zone -
  // the request carries none - so a "local" time here would silently be the
  // server's, which is worse than a stated UTC.

  'aig.date': {
    resolve: ({ now }) => now.toISOString().slice(0, 10),
  },

  'aig.time': {
    resolve: ({ now }) => now.toISOString().slice(11, 19),
  },

  'aig.datetime': {
    resolve: ({ now }) => now.toISOString(),
  },

  'aig.timestamp': {
    resolve: ({ now }) => String(Math.floor(now.getTime() / 1000)),
  },

  'aig.year': {
    resolve: ({ now }) => now.toISOString().slice(0, 4),
  },

  'aig.month': {
    resolve: ({ now }) => now.toISOString().slice(5, 7),
  },

  'aig.day': {
    resolve: ({ now }) => now.toISOString().slice(8, 10),
  },

  'aig.weekday': {
    resolve: ({ now }) => part(now, { weekday: 'long' }),
  },

  'aig.month_name': {
    resolve: ({ now }) => part(now, { month: 'long' }),
  },

  'aig.date_long': {
    resolve: ({ now }) => part(now, { year: 'numeric', month: 'long', day: 'numeric' }),
  },

  'aig.organization_name': {
    resolve: ({ organization }) => organization.name,
  },

  'aig.organization_id': {
    resolve: ({ organization }) => organization.id,
  },

  'aig.prompt_name': {
    resolve: ({ prompt }) => prompt.name,
  },

  'aig.prompt_version': {
    resolve: ({ prompt }) => String(prompt.version),
  },

  // NOTE: Relies on middleware upstream.
  'aig.request_id': {
    resolve: ({ requestId }) => requestId,
  },

  'aig.uuid': {
    resolve: () => globalThis.crypto.randomUUID(),
  },
} as const satisfies Record<string, Builtin>;

export type BuiltinName = keyof typeof BUILTINS;
const BUILTIN_PREFIX = 'aig.';

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
