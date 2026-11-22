import type { ItemState } from './lifecycle';

/** Where an imported purchase line stands in the possession check. */
export type Possession = 'pending' | 'owned' | 'gone' | 'ignored';
export const POSSESSIONS: readonly Possession[] = ['pending', 'owned', 'gone', 'ignored'];

/** Why a thing is gone; the same words as the item states that end an item's life. */
export type GoneReason = Extract<ItemState, 'sold' | 'given_away' | 'disposed' | 'lost' | 'returned' | 'consumed'>;
export const GONE_REASONS: readonly GoneReason[] = ['sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed'];

/**
 * Shop titles are long ("Brand X Cordless Drill 18V, 2 Batteries, Case, …"). The item name
 * keeps the part before the first list separator once it is long enough, else cuts at a word.
 */
export function shortItemName(title: string, max = 80): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(...[', ', ' - ', ' – ', ' | ', ' (', '; '].map((s) => head.lastIndexOf(s)));
  if (cut >= 20) return head.slice(0, cut).trim();
  const space = head.lastIndexOf(' ');
  return `${(space >= 20 ? head.slice(0, space) : head).trim()}…`;
}
