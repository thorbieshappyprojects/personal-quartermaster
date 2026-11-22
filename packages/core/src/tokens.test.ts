import { describe, expect, it } from 'vitest';
import { generateApiToken, hashApiToken, looksLikeApiToken, parseBearer, sameHash } from './tokens';

describe('api tokens', () => {
  it('generates distinct, well-formed tokens whose hash matches', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.token).not.toBe(b.token);
    expect(looksLikeApiToken(a.token)).toBe(true);
    expect(sameHash(hashApiToken(a.token), a.hash)).toBe(true);
    expect(sameHash(a.hash, b.hash)).toBe(false);
  });

  it('parses bearer headers', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer abc ')).toBe('abc');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(looksLikeApiToken('nope')).toBe(false);
  });
});
