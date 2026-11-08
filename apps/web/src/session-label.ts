/** 列表行用哪句字。用户起过名优先；否则用会话的第一句话，最近几条预览里没有它也一样。 */
export function sessionListLabel(input: {
  readonly title: string | null | undefined;
  readonly previewText: string;
  readonly opening: string | undefined;
  readonly index: number;
}): string {
  if (input.title) return input.title;
  const text = (input.opening || input.previewText).replace(/\s+/g, ' ').trim();
  if (!text) return `会话 ${input.index + 1}`;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
