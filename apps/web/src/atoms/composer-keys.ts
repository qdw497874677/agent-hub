/**
 * 输入框里「带 ⌘/Ctrl 的回车」是哪一种发送。
 *
 * 单独放一份纯函数，是因为两个输入框（专注对话的大盒子、画布卡片上的一行）都要认这两个手势，
 * 而它们对「什么时候能发」的判断各不相同：这里只回答「按的是哪个手势」，发不发由各自决定。
 */
export interface ComposerKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

export type ComposerKeyAction = 'send' | 'send-and-new' | null;

/**
 * `⌘/Ctrl+Enter` = 发送；再加 `Shift` = 发送并新开一条会话。
 * 没有修饰键时返回 null：Enter 本身该换行还是该发送，由各自的输入框决定。
 */
export function composerKeyAction(event: ComposerKeyEvent): ComposerKeyAction {
  if (event.key !== 'Enter') return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  return event.shiftKey ? 'send-and-new' : 'send';
}
