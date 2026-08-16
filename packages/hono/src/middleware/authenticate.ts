import type { Context, Next } from 'hono';
import { getConnInfo } from 'hono/bun';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

// Make Caller visible on the Hono context.
declare module 'hono' {
  interface ContextVariableMap {
    /** The authenticated caller attached by authenticate(). */
    caller: Caller;
  }
}

/**
 * A human resolved to the application's stable, IDP-independent identity.
 */
export interface UserIdentity {
  /** A stable identifier of the user. */
  id: string;

  /** The IDP-assigned username of the user. */
  username: string;

  /** The IDP-assigned email of the user. */
  email: string;

  /** The IDP-assigned display name of the user. */
  displayName?: string;

  /** The IDP-assigned first name of the user. */
  firstName?: string;

  /** The IDP-assigned last name of the user. */
  lastName?: string;
}

/**
 * The API key credential that authenticated a request.
 */
interface ApiKeyIdentity {
  /** A stable identifier of the API key. */
  id: string;

  /** The name of the API key. */
  name: string;
}

/**
 * The tenant resolved from a trusted credential.
 */
interface OrganizationIdentity {
  /** A stable identifier of the organization. */
  id: string;

  /** The name of the organization. */
  name: string;
}

/**
 * The effective grants adapters have resolved for a caller.
 */
interface Permissions {
  /** The scopes granted to the caller. */
  readonly scopes: readonly string[];
}

/**
 * Transport facts collected by authenticate() before an adapter runs.
 */
interface RequestInfo {
  /** The request identifier, when assigned by upstream middleware. */
  readonly id?: string;

  /** The remote IP address of the request, when available. */
  readonly ipAddress?: string;

  /** The User-Agent header of the request, when provided. */
  readonly userAgent?: string;
}

/**
 * An authenticated (probably human) user.
 */
interface UserActor {
  /** Identifies the actor as a user. */
  type: 'user';

  /** The user who authenticated the request. */
  user: UserIdentity;
}

/**
 * An authenticated API key.
 */
interface ApiKeyActor {
  /** Identifies the actor as an API key. */
  type: 'api_key';

  /** The API key that authenticated the request. */
  key: ApiKeyIdentity;

  /** The user who owns the API key. */
  owner: UserIdentity;
}

/**
 * The authenticated identity responsible for a request.
 */
type Actor = UserActor | ApiKeyActor;

/**
 * Credential-derived identity returned by an authentication adapter.
 */
export interface CallerIdentity {
  /** The organization under which the caller is operating. */
  organization: OrganizationIdentity;

  /** The identity responsible for the request. */
  actor: Actor;

  /** The effective permissions granted to the caller. */
  permissions: Permissions;
}

/**
 * The complete authenticated principal attached to the Hono request context.
 */
export interface Caller extends CallerIdentity {
  /** Transport information collected from the request. */
  request: RequestInfo;
}

/**
 * Input provided to a JWT authentication adapter.
 */
interface JWTAuthAdapterInput {
  /** The JWT bearer credential to authenticate. */
  token: string;

  /** Transport information collected from the request. */
  request: RequestInfo;
}

/**
 * Input provided to an API key authentication adapter.
 */
interface KeyAuthAdapterInput {
  /** The API key bearer credential to authenticate. */
  key: string;

  /** Transport information collected from the request. */
  request: RequestInfo;
}

/**
 * Authenticates a JWT and returns its resolved caller identity.
 */
export type JWTAuthAdapter = (input: JWTAuthAdapterInput) => Promise<CallerIdentity>;

/**
 * Authenticates an API key and returns its resolved caller identity.
 */
export type KeyAuthAdapter = (input: KeyAuthAdapterInput) => Promise<CallerIdentity>;

/**
 * Options to configure the authentication middleware.
 */
interface AuthenticateOptions {
  /** The adapter used for JWT-shaped bearer credentials. */
  jwtAdapter: JWTAuthAdapter;

  /**
   * The adapter used for non-JWT bearer credentials. When omitted, API key
   * authentication is rejected.
   */
  keyAdapter?: KeyAuthAdapter;
}

// Compact JWS form - literally just (header.payload.signature)
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Middleware that routes the bearer credential from the Authorization header to
 * the matching adapter and attaches the resulting Caller to the context.
 *
 * TLDR: it validates authenticated requests and attaches helpful info to the
 * context.
 *
 * @param options
 * Set of options to configure the middleware.
 *
 * @returns
 * An async middleware function.
 */
export function authenticate(options: AuthenticateOptions) {
  const { jwtAdapter, keyAdapter } = options;

  return createMiddleware(async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    const token = /^Bearer +(\S+)$/i.exec(header ?? '')?.[1];

    // Try to sanity check the format first.
    if (!token) {
      throw new HTTPException(401, {
        cause: 'Missing or malformed Authorization header',
      });
    }

    const request: RequestInfo = {
      id: c.var.requestId, // Make sure this is set by upstream middleware
      ipAddress: getConnInfo(c).remote.address, // this might be wrong with a reverse proxy... todo fix/investigate, i guess
      userAgent: c.req.header('user-agent'),
    };

    // Figure out if we're dealing with an API key or a JWT. Just assume that if
    // it's not JWT shaped, it's an API key - it'll be handled by the key
    // adapter.
    const isJwt = JWT_PATTERN.test(token);
    let identity: CallerIdentity;
    if (isJwt) {
      identity = await jwtAdapter({
        token: token,
        request,
      });
    } else {
      if (!keyAdapter) {
        throw new HTTPException(401, {
          cause: 'Attempted API key authentication but no key adapter is configured',
        });
      }

      identity = await keyAdapter({
        key: token,
        request,
      });
    }

    // We should have a valid identity from the adapter by now...
    const caller: Caller = {
      ...identity,
      request,
    };

    c.set('caller', caller);
    await next();
  });
}
