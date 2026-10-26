/**
 * 选中一张卡后右栏会把画布挤窄：卡片可能一半落到右栏底下，连右下角的缩放把手也被盖住。
 * 这里算「最少要平移多少」才能让它整个露出来——只平移，不改缩放，人刚才看的东西不跳。
 */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MARGIN = 24;

function shift(start: number, length: number, available: number): number {
  // 放得下：右（下）边越界就往回推，左（上）边越界就往前推；放不下就让开头对齐。
  if (length + MARGIN * 2 > available) return MARGIN - start;
  if (start < MARGIN) return MARGIN - start;
  if (start + length > available - MARGIN) return available - MARGIN - (start + length);
  return 0;
}

/** 返回新的视口；已经完全可见时原样返回同一个对象。 */
export function panIntoView(viewport: Viewport, node: Rect, screen: { width: number; height: number }): Viewport {
  const left = node.x * viewport.zoom + viewport.x;
  const top = node.y * viewport.zoom + viewport.y;
  const dx = shift(left, node.width * viewport.zoom, screen.width);
  const dy = shift(top, node.height * viewport.zoom, screen.height);
  if (dx === 0 && dy === 0) return viewport;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
}

/**
 * 打开画布时的视口：放得下就整体居中适配（同 React Flow 的 fitView）；
 * 放不下（手机上桌面排开的宽布局）就按可读的最小缩放把整棵树的左上角对齐到屏幕左上。
 * 以前一律居中，手机上树的开头会落到屏幕左边外面，一打开就看不到卡片。
 */
export function openingViewport(
  bounds: Rect,
  screen: { width: number; height: number },
  limits: { padding: number; minZoom: number; maxZoom: number }
): Viewport {
  const fit = Math.min(
    screen.width / (bounds.width * (1 + limits.padding * 2)),
    screen.height / (bounds.height * (1 + limits.padding * 2))
  );
  if (fit >= limits.minZoom) {
    const zoom = Math.min(fit, limits.maxZoom);
    return {
      x: screen.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: screen.height / 2 - (bounds.y + bounds.height / 2) * zoom,
      zoom
    };
  }
  const zoom = limits.minZoom;
  return { x: MARGIN - bounds.x * zoom, y: MARGIN - bounds.y * zoom, zoom };
}
