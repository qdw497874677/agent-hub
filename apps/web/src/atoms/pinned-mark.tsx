/**
 * 常驻的小图钉：会话头部和画布卡片共用同一枚图标（颜色和尺寸由调用处给）。
 *
 * 常驻 = Worker 不按空闲回收这条会话，也不占保活上限。它是个稳定状态、不是告警，
 * 所以只占一个图标位，说明放在 title 里；读屏靠 aria-label 听到「常驻」。
 */
export function PinnedMark({ testId, className = 'size-3' }: { readonly testId: string; readonly className?: string }) {
  return (
    <span
      role="img"
      aria-label="常驻"
      title="常驻：不会因空闲被回收"
      data-testid={testId}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-full"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 图钉：帽、身、针三点一线，10px 上也能认出来 */}
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
    </span>
  );
}
