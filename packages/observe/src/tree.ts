import type { ObserveBranch, ObserveNode, ObserveTrace, ObserveTree } from './types.ts';

/** 两个时间都有、且结束不早于开始，才是一段耗时。 */
export function durationBetween(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt === null || endedAt === null || endedAt < startedAt) return null;
  return endedAt - startedAt;
}

/**
 * 把节点收成树。
 * 父子只认 parentId 且目标就在这批节点里。
 * 父级 id 对不上：不挂到别人下面。
 * 链接不是子节点。链接目标若再有链接，沿虚线展开，遇到环就停。
 * kind 为 sink 的节点进「未记录」，不进树。
 */
export function buildTree(trace: Pick<ObserveTrace, 'headId' | 'nodes'>): ObserveTree {
  const index = new Map(trace.nodes.map((node) => [node.id, node]));
  const missingParent = trace.nodes.filter((node) => node.parentId !== null && !index.has(node.parentId));
  const missingIds = new Set(missingParent.map((node) => node.id));
  const childrenOf = new Map<string, ObserveNode[]>();
  for (const node of trace.nodes) {
    if (node.parentId === null || !index.has(node.parentId)) continue;
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  const linked = new Set<string>();
  for (const node of trace.nodes) {
    for (const link of node.links) if (index.has(link.to)) linked.add(link.to);
  }
  const sink = (node: ObserveNode) => node.kind === 'sink';
  const branch = (node: ObserveNode, seen: ReadonlySet<string>): ObserveBranch => {
    const next = new Set(seen);
    next.add(node.id);
    return {
      node,
      children: (childrenOf.get(node.id) ?? []).filter((child) => !sink(child)).map((child) => branch(child, next)),
      links: node.links.flatMap((link) => {
        const target = index.get(link.to);
        if (!target || sink(target) || seen.has(target.id)) return [];
        return [{ label: link.label, branch: branch(target, next) }];
      })
    };
  };
  const roots = trace.nodes.filter((node) => {
    if (sink(node) || missingIds.has(node.id)) return false;
    if (node.id === trace.headId) return true;
    if (node.parentId !== null || linked.has(node.id)) return false;
    return (childrenOf.get(node.id) ?? []).length > 0;
  });
  const placed = new Set<string>();
  const walk = (item: ObserveBranch) => {
    placed.add(item.node.id);
    item.children.forEach(walk);
    item.links.forEach((link) => walk(link.branch));
  };
  const treeRoots = roots.map((node) => branch(node, new Set()));
  treeRoots.forEach(walk);
  return {
    roots: treeRoots,
    missingParent,
    unlinked: trace.nodes.filter((node) => !sink(node) && !missingIds.has(node.id) && !placed.has(node.id)),
    unrecorded: trace.nodes.filter(sink)
  };
}
