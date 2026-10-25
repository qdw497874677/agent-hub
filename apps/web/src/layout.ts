type Point = { readonly x: number; readonly y: number };

/**
 * 给新出现的节点补上默认位置，已有的（用户拖过的、服务端存过的）一个不动。
 *
 * 画布的位置是组件状态，只在挂载时从默认布局初始化一次；之后新派生/分叉的会话、
 * 新建的任务都没有位置，会全部落在 (0,0) 叠成一摞——分叉出来的卡正好盖住来源卡。
 * 没有新节点时返回原对象，避免无谓的重渲染。
 */
export function fillMissing<P extends Point>(
  current: Readonly<Record<string, P>>,
  defaults: Readonly<Record<string, P>>
): Record<string, P> {
  let next: Record<string, P> | null = null;
  for (const [id, point] of Object.entries(defaults)) {
    if (current[id] !== undefined) continue;
    next ??= { ...current };
    next[id] = point;
  }
  return next ?? (current as Record<string, P>);
}
