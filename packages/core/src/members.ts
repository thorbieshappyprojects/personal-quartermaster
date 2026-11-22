export type Role = 'owner' | 'member';
export const ROLES: readonly Role[] = ['owner', 'member'];

/** True if changing `currentRole` to `nextRole` would leave the household without an owner. */
export function wouldRemoveLastOwner(ownerCount: number, currentRole: Role, nextRole: Role): boolean {
  return currentRole === 'owner' && nextRole !== 'owner' && ownerCount <= 1;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
