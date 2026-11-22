import { wouldCreateCycle, type TreeNode } from './tree';

export type LocationKind = 'site' | 'room' | 'spot' | 'container';
export const LOCATION_KINDS: readonly LocationKind[] = ['site', 'room', 'spot', 'container'];

const RANK: Record<LocationKind, number> = { site: 0, room: 1, spot: 2, container: 3 };

export interface LocationNode extends TreeNode {
  kind: LocationKind;
}

/**
 * A site is always a root. Below it, kinds only get finer (a car can hold a spot directly),
 * and containers may sit inside other containers (a box in a box).
 */
export function canNest(parent: LocationKind | null, child: LocationKind): boolean {
  if (child === 'site') return parent === null;
  if (parent === null) return false;
  if (child === 'container' && parent === 'container') return true;
  return RANK[child] > RANK[parent];
}

export type PlacementError = 'parent_not_found' | 'invalid_nesting' | 'cycle';

export function checkPlacement(
  nodes: readonly LocationNode[],
  input: { id?: string; kind: LocationKind; parentId: string | null },
): PlacementError | null {
  const parent = input.parentId ? nodes.find((n) => n.id === input.parentId) : null;
  if (input.parentId && !parent) return 'parent_not_found';
  if (!canNest(parent?.kind ?? null, input.kind)) return 'invalid_nesting';
  if (input.id && wouldCreateCycle(nodes, input.id, input.parentId)) return 'cycle';
  // Existing children must still fit below the (possibly new) kind.
  if (input.id) {
    for (const child of nodes.filter((n) => n.parent_id === input.id)) {
      if (!canNest(input.kind, child.kind)) return 'invalid_nesting';
    }
  }
  return null;
}
