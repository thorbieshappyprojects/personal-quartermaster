/** Generic helpers for parent-pointer trees (locations, categories). */
export interface TreeNode {
  id: string;
  parent_id: string | null;
  name: string;
}

export function indexById<T extends TreeNode>(nodes: readonly T[]): Map<string, T> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** Ancestors from the root down to the node itself. Stops on a cycle instead of looping. */
export function lineage<T extends TreeNode>(index: Map<string, T>, id: string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  let cur = index.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parent_id ? index.get(cur.parent_id) : undefined;
  }
  return out;
}

export function pathNames<T extends TreeNode>(index: Map<string, T>, id: string): string[] {
  return lineage(index, id).map((n) => n.name);
}

export function descendantIds<T extends TreeNode>(nodes: readonly T[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = children.get(n.parent_id) ?? [];
    list.push(n.id);
    children.set(n.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/** True if giving `id` the parent `newParentId` would make a node its own ancestor. */
export function wouldCreateCycle<T extends TreeNode>(nodes: readonly T[], id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  if (newParentId === id) return true;
  return descendantIds(nodes, id).has(newParentId);
}
