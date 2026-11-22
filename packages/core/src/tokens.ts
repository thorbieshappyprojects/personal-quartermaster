import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'pqt_';
const TOKEN = /^pqt_[A-Za-z0-9_-]{43}$/;

/** A new per-member API token. Only its hash is stored; the plaintext is shown once. */
export function generateApiToken(): { token: string; hash: Buffer } {
  const token = PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashApiToken(token) };
}

export function hashApiToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function looksLikeApiToken(token: string): boolean {
  return TOKEN.test(token);
}

/** Extracts the token from an `Authorization: Bearer …` header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
