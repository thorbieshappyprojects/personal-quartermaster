import { hashApiToken, looksLikeApiToken, parseBearer } from '@pq/core';
import { findMemberByEmail, findMemberByTokenHash, type Member } from '@pq/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config';

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
/** Dev-only override of the acting member's e-mail. Ignored unless DEV_AUTH=1. */
export const DEV_EMAIL_HEADER = 'x-pq-dev-email';

export type AccessVerifier = (jwt: string) => Promise<JWTPayload>;

export interface Identity {
  member: Member;
  via: 'browser' | 'service' | 'dev';
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}

/** Verifies a Cloudflare Access JWT against the team's signing keys, issuer and application audience. */
export function createAccessVerifier(
  teamDomain: string,
  audience: string,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  }),
): AccessVerifier {
  const issuer = `https://${teamDomain}`;
  return async (jwt) => {
    const { payload } = await jwtVerify(jwt, jwks, { issuer, audience, algorithms: ['RS256'], clockTolerance: 30 });
    return payload;
  };
}

class AuthFailure extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function deny(reply: FastifyReply, failure: AuthFailure): FastifyReply {
  return reply.code(failure.status).send({ error: failure.status === 401 ? 'unauthenticated' : 'forbidden' });
}

export async function registerAuth(
  app: FastifyInstance,
  auth: AuthConfig,
  verifier: AccessVerifier | undefined,
): Promise<void> {
  const verify =
    auth.mode === 'access' ? (verifier ?? createAccessVerifier(auth.teamDomain, auth.audience)) : undefined;

  app.decorateRequest('identity', null as unknown as Identity);

  async function resolve(req: FastifyRequest): Promise<Identity> {
    const pool = app.deps.pool;
    if (auth.mode === 'dev') {
      const header = req.headers[DEV_EMAIL_HEADER];
      const email = (typeof header === 'string' && header) || auth.email;
      const member = await findMemberByEmail(pool, email);
      if (!member) throw new AuthFailure(403, 'dev e-mail is not a member (run `pnpm pq init`)');
      return { member, via: 'dev' };
    }

    const jwt = req.headers[ACCESS_HEADER];
    if (typeof jwt !== 'string' || jwt.length === 0) throw new AuthFailure(401, 'missing access assertion');
    let payload: JWTPayload;
    try {
      payload = await verify!(jwt);
    } catch {
      throw new AuthFailure(401, 'invalid access assertion');
    }

    const email = typeof payload.email === 'string' ? payload.email : null;
    if (email) {
      const member = await findMemberByEmail(pool, email);
      if (!member) throw new AuthFailure(403, 'identity is not a member');
      return { member, via: 'browser' };
    }

    // Service-token assertion: carries no person, so a per-member API token is required.
    if (typeof payload.common_name !== 'string' || payload.common_name.length === 0) {
      throw new AuthFailure(403, 'assertion has neither e-mail nor service token');
    }
    const token = parseBearer(req.headers.authorization);
    if (!token || !looksLikeApiToken(token)) throw new AuthFailure(403, 'service request without api token');
    const member = await findMemberByTokenHash(pool, hashApiToken(token));
    if (!member) throw new AuthFailure(403, 'unknown or revoked api token');
    return { member, via: 'service' };
  }

  // Every request passes the gate, including /healthz and static files.
  app.addHook('onRequest', async (req, reply) => {
    try {
      req.identity = await resolve(req);
    } catch (err) {
      if (err instanceof AuthFailure) {
        req.log.info({ reason: err.reason }, 'request denied');
        return deny(reply, err);
      }
      throw err;
    }
  });
}

export function requireOwner(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  if (req.identity.member.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
  return undefined;
}
