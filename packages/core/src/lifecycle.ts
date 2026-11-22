export type ItemState =
  | 'owned'
  | 'unknown'
  | 'lent'
  | 'sold'
  | 'given_away'
  | 'disposed'
  | 'lost'
  | 'returned'
  | 'consumed';

export const ITEM_STATES: readonly ItemState[] = [
  'owned', 'unknown', 'lent', 'sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed',
];

/** States in which the household still has the thing (lent: it comes back). */
export const IN_POSSESSION: readonly ItemState[] = ['owned', 'lent'];
/** States that end the item's life in the household. */
export const GONE: readonly ItemState[] = ['sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed'];

export function isGone(state: ItemState): boolean {
  return GONE.includes(state);
}

export const STATE_LABELS: Record<ItemState, string> = {
  owned: 'owned',
  unknown: 'unknown',
  lent: 'lent out',
  sold: 'sold',
  given_away: 'given away',
  disposed: 'disposed of',
  lost: 'lost',
  returned: 'returned',
  consumed: 'used up',
};

export type ItemKind = 'durable' | 'supply';
export const ITEM_KINDS: readonly ItemKind[] = ['durable', 'supply'];
