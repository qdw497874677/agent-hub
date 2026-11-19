/**
 * 「回到底部」：读者往上翻出内容后，浮在转写区底部的一枚小胶囊。
 *
 * 显隐不在这里判断——调用方传 `visible`（来自 useStickToBottom 的 `nearEnd`，24px 宽松阈值）。
 * 位置：滚动容器的兄弟节点，absolute 相对「包着滚动区」的相对定位盒子，
 * 所以它不跟着内容滚走，也不会压到下面的 composer。
 * 命中区用 `min-h-[40px]` 写死像素：这个 app 的 html 字号是 13px，
 * `min-h-10` 会算成 32.5px，手机上点不住。
 */
export function ScrollToEnd({
  visible,
  onClick
}: {
  readonly visible: boolean;
  readonly onClick: () => void;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      data-testid="scroll-to-end"
      aria-label="回到底部"
      title="回到底部"
      onClick={(event) => {
        // 画布卡片里：别让点击冒泡成「选中 / 双击展开」。
        event.stopPropagation();
        onClick();
      }}
      className="nodrag absolute bottom-4 left-1/2 z-10 inline-flex min-h-[40px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-strong bg-overlay px-3.5 text-meta text-secondary shadow-overlay transition-colors hover:border-fg/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:animate-[scroll-to-end-in_var(--dur-base)_var(--ease-drawer)] motion-reduce:animate-none"
    >
      <span aria-hidden className="text-tertiary">
        ↓
      </span>
      <span>回到底部</span>
    </button>
  );
}
