import { describe, expect, it } from 'vitest';
import { isPlausibleEmail, normaliseEmail, wouldRemoveLastOwner } from './members';

describe('member rules', () => {
  it('protects the last owner', () => {
    expect(wouldRemoveLastOwner(1, 'owner', 'member')).toBe(true);
    expect(wouldRemoveLastOwner(2, 'owner', 'member')).toBe(false);
    expect(wouldRemoveLastOwner(1, 'owner', 'owner')).toBe(false);
    expect(wouldRemoveLastOwner(1, 'member', 'member')).toBe(false);
  });

  it('normalises and checks e-mails', () => {
    expect(normaliseEmail('  A@Example.TEST ')).toBe('a@example.test');
    expect(isPlausibleEmail('a@example.test')).toBe(true);
    expect(isPlausibleEmail('a@b')).toBe(false);
    expect(isPlausibleEmail('a b@example.test')).toBe(false);
  });
});
