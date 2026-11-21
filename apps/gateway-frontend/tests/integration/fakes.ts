import { spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectRedis, redis } from '@repo/redis';
import type { Cookies } from '@sveltejs/kit';

// The issuer and the client id that setup.ts gives the server.
const ISSUER = 'https://idp.test';
const CLIENT_ID = 'test-client';

// Who the provider says has signed in.
const SUBJECT = 'user-1';

export const ENDPOINTS = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  end_session_endpoint: `${ISSUER}/end-session`,
  revocation_endpoint: `${ISSUER}/revoke`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

export type FakeCookies = Cookies & { jar: Map<string, string> };

/**
 * Enough of SvelteKit's cookies for the server's own modules, kept in a map.
 */
export function fakeCookies(): FakeCookies {
  const jar = new Map<string, string>();

  return {
    jar: jar,
    get: (name: string) => jar.get(name),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  } as unknown as FakeCookies;
}

/**
 * Removes the sessions a suite left behind.
 */
export async function clearSessions(): Promise<void> {
  await connectRedis();

  // Only session keys, and never the whole database. Flushing would empty
  // whatever the environment points at, which could be a suite running beside
  // this one.
  const keys = await redis.keys('relay:session:*');

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

/**
 * A stand-in identity provider. It answers the requests the server makes of a
 * real one, and keeps what it was sent.
 */
export class FakeIdp {
  /**
   * The form each token request carried, refused ones included.
   */
  tokenRequests: URLSearchParams[] = [];

  /**
   * The refresh tokens it was asked to revoke.
   */
  revoked: string[] = [];

  /**
   * How long a token request takes.
   */
  delayMs = 0;

  /**
   * What goes wrong with a token request, if anything. The provider can refuse
   * the grant, be out of service, or accept the request and never answer it.
   */
  trouble: 'refuses' | 'unavailable' | 'silent' | null = null;

  /**
   * How long it says an access token lasts, or undefined to leave that out.
   */
  expiresIn: number | undefined = 3600;

  /**
   * The claims in the ID tokens it issues, and what UserInfo answers with.
   */
  idTokenClaims: Record<string, unknown> = {};
  userInfo: Record<string, unknown> = {};

  #issued = 0;
  #fetch = spyOn(globalThis, 'fetch');

  constructor() {
    // Cast because Bun's fetch type also carries `preconnect`, which a stand-in
    // has no use for.
    this.#fetch.mockImplementation(((input, init) => this.#answer(new Request(input, init))) as typeof fetch);
  }

  /**
   * Gives the network back.
   */
  stop(): void {
    this.#fetch.mockRestore();
  }

  async #answer(request: Request): Promise<Response> {
    switch (request.url) {
      case `${ISSUER}/.well-known/openid-configuration`:
        return Response.json({ issuer: ISSUER, ...ENDPOINTS });

      case ENDPOINTS.token_endpoint:
        return this.#issue(request);

      case ENDPOINTS.revocation_endpoint:
        this.revoked.push(new URLSearchParams(await request.text()).get('token') ?? '');

        return new Response(null);

      case ENDPOINTS.userinfo_endpoint:
        return Response.json({ sub: SUBJECT, ...this.userInfo });

      default:
        throw new Error(`The identity provider was asked for ${request.url}, which it does not serve.`);
    }
  }

  async #issue(request: Request): Promise<Response> {
    this.tokenRequests.push(new URLSearchParams(await request.text()));

    // A real token endpoint is a network round trip. Without a delay, calls
    // made together would each finish before the next began, and the renewal
    // lock would never be contended.
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    switch (this.trouble) {
      case 'refuses':
        return Response.json({ error: 'invalid_grant' }, { status: 400 });

      case 'unavailable':
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });

      // Ends only when the caller gives up, which is the caller's own deadline
      // and nothing this provider does.
      case 'silent':
        await new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        });
    }

    this.#issued += 1;

    return Response.json({
      access_token: `access-${this.#issued}`,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      refresh_token: `refresh-${this.#issued}`,
      id_token: this.#idToken(),
    });
  }

  /**
   * An ID token with everything in it that a client checks. The signature is
   * not a real one, because a client that received the token straight from the
   * token endpoint has no need to verify it.
   */
  #idToken(): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: SUBJECT,
      iat: issuedAt,
      exp: issuedAt + 3600,
      ...this.idTokenClaims,
    };

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

    return `${header}.${payload}.signature-${this.#issued}`;
  }
}
