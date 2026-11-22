import { generateApiToken } from '@pq/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { ACCESS_HEADER, createAccessVerifier, DEV_EMAIL_HEADER } from './auth';
import { createTestApp, type TestContext } from './testing';

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'test-audience-tag';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function sign(key: Key, claims: JWTPayload, opts: { aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(key);
}

describe('Access gate', () => {
  let t: TestContext;
  let key: Key;
  let otherKey: Key;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    const verifier = createAccessVerifier(TEAM, AUD, createLocalJWKSet({ keys: [jwk] }));
    t = await createTestApp({ mode: 'access', teamDomain: TEAM, audience: AUD }, { accessVerifier: verifier });
  });
  afterAll(async () => t.close());

  const get = (headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url: '/healthz', headers });

  it('rejects requests without an assertion, including /healthz and unknown paths', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
    expect((await get()).json()).toEqual({ error: 'unauthenticated' });
  });

  it('rejects bad signatures, wrong audience, wrong issuer and expired tokens', async () => {
    const claims = { email: 'owner@example.test' };
    for (const jwt of [
      await sign(otherKey, claims),
      await sign(key, claims, { aud: 'other' }),
      await sign(key, claims, { iss: 'https://evil.cloudflareaccess.com' }),
      await sign(key, claims, { exp: '-5m' }),
      'not-a-jwt',
    ]) {
      expect((await get({ [ACCESS_HEADER]: jwt })).statusCode).toBe(401);
    }
  });

  it('maps a browser identity to a member', async () => {
    const res = await get({ [ACCESS_HEADER]: await sign(key, { email: 'OWNER@example.test' }) });
    expect(res.statusCode).toBe(200);
  });

  it('refuses identities that are not members', async () => {
    const res = await get({ [ACCESS_HEADER]: await sign(key, { email: 'stranger@example.test' }) });
    expect(res.statusCode).toBe(403);
  });

  describe('service tokens', () => {
    const service = () => sign(key, { common_name: 'device-client-id.access', sub: '' });

    it('need a per-member API token', async () => {
      expect((await get({ [ACCESS_HEADER]: await service() })).statusCode).toBe(403);
      expect(
        (await get({ [ACCESS_HEADER]: await service(), authorization: `Bearer ${generateApiToken().token}` })).statusCode,
      ).toBe(403);
    });

    it('work with a valid API token and record its use; revoked tokens fail', async () => {
      const { token, hash } = generateApiToken();
      const { rows } = await t.pool.query<{ id: string }>(
        "INSERT INTO api_token (member_id, token_hash, label) VALUES ($1, $2, 'phone') RETURNING id",
        [t.ownerId, hash],
      );
      const headers = { [ACCESS_HEADER]: await service(), authorization: `Bearer ${token}` };
      expect((await get(headers)).statusCode).toBe(200);
      const used = await t.pool.query('SELECT last_used_at FROM api_token WHERE id = $1', [rows[0]!.id]);
      expect(used.rows[0].last_used_at).not.toBeNull();

      await t.pool.query('UPDATE api_token SET revoked_at = now() WHERE id = $1', [rows[0]!.id]);
      expect((await get(headers)).statusCode).toBe(403);
    });

    it('do not accept an API token without the Access assertion', async () => {
      const { token, hash } = generateApiToken();
      await t.pool.query("INSERT INTO api_token (member_id, token_hash, label) VALUES ($1, $2, 'x')", [t.ownerId, hash]);
      expect((await get({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
    });
  });
});

describe('DEV_AUTH', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('acts as the configured member and allows a dev e-mail override', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const res = await t.app.inject({ method: 'GET', url: '/healthz', headers: { [DEV_EMAIL_HEADER]: 'nobody@example.test' } });
    expect(res.statusCode).toBe(403);
  });
});
