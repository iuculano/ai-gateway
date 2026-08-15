import type { Context, Next } from 'hono';
import { getConnInfo } from 'hono/bun';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

// Make Caller visible on the Hono context.
declare module 'hono' {
  interface ContextVariableMap {
    caller: Caller;
  }
}

/** A human resolved to the application's stable, IDP-independent identity. */
export interface UserIdentity {
  id: string;
  username: string;
  email: string;

  // No guarantees that the IDP will provide these.
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

/** The API key credential that authenticated a request. */
export interface ApiKeyIdentity {
  id: string;
  name: string;
}

/** The tenant resolved from a trusted credential. */
export interface OrganizationIdentity {
  id: string;
  name: string;
}

/** The effective grants adapters have resolved for a caller. */
export interface Permissions {
  readonly scopes: readonly string[];
}

/** Transport facts collected by authenticate() before an adapter runs. */
export interface RequestInfo {
  readonly id?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/** 
 * An authenticated (probably human) user.
 */
export interface UserActor {
  type: 'user';
  user: UserIdentity;
}

/** 
 * An authenticated API key.
 */
export interface ApiKeyActor {
  type: 'api_key';
  key: ApiKeyIdentity;
  owner: UserIdentity;
}

export type Actor = UserActor | ApiKeyActor;

/** Credential-derived identity returned by an authentication adapter. */
export interface CallerIdentity {
  organization: OrganizationIdentity;
  actor: Actor;
  permissions: Permissions;
}

/** The complete authenticated principal attached to the Hono request context. */
export interface Caller extends CallerIdentity {
  request: RequestInfo;
}


export interface JWTAuthAdapterInput {
  token: string;
  request: RequestInfo;
}

export interface KeyAuthAdapterInput {
  key: string;
  request: RequestInfo;
}

export type JWTAuthAdapter = (input: JWTAuthAdapterInput) => Promise<CallerIdentity>;
export type KeyAuthAdapter = (input: KeyAuthAdapterInput) => Promise<CallerIdentity>;

export interface AuthenticateOptions {
  jwtAdapter: JWTAuthAdapter;
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
    const [scheme, token] = header?.split(' ') ?? [];

    // Try to sanity check the format first.
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
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
