/**
 * 列表底部那一行「A、B 正在输入…」。
 *
 * 文案在外面由 `group-live.typingLine` 拼好；这里只画，拿不到文案就由调用方不渲染（不占位）。
 */
export function TypingLine({ line }: { readonly line: string }) {
  return (
    <li
      data-testid="group-typing"
      className="my-1.5 flex items-center gap-1.5 px-1 text-meta text-tertiary"
    >
      <span aria-hidden className="flex gap-0.5 text-sage">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      <span className="min-w-0 truncate">{line}</span>
    </li>
  );
}
