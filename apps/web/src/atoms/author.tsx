/** 用户气泡旁的头像 + 名字（多人在同一条会话里说话时才显示）。 */
const PALETTE = ['bg-sage/30', 'bg-accent/30', 'bg-rust/25', 'bg-card-raised'];

function hue(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]!;
}

export function AuthorTag({ author, size = 'md' }: { author: { id: string; name: string; via?: string } | undefined; size?: 'md' | 'sm' }) {
  const name = author?.name ?? '不知道是谁';
  const via = author?.via;
  const initial = author ? [...author.name.trim()][0] ?? '?' : '?';
  const box = size === 'sm' ? 'h-4 w-4 text-[10px]' : 'h-5 w-5 text-[11px]';
  return (
    <span className="flex items-center gap-1 text-meta text-tertiary" data-testid="msg-author" title={via === 'agent' ? `${name}（agent 间消息）` : via ? `${name}（经令牌「${via}」）` : name}>
      <span className="max-w-[160px] truncate">{name}</span>
      {via && (
        <span className="max-w-[120px] truncate rounded bg-card-raised px-1 text-[10px]" data-testid="msg-author-via">
          {via === 'agent' ? 'agent 消息' : `via ${via}`}
        </span>
      )}
      <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium text-primary ${box} ${author ? hue(author.id) : 'bg-card-raised'}`}>
        {initial.toUpperCase()}
      </span>
    </span>
  );
}
