import type { SessionDto } from './api.ts';

interface Props {
  readonly session: SessionDto;
  readonly agentLabel: string;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** 专注对话里盒子更大、能长高；画布右栏里它受限于 320px 宽。 */
  readonly large?: boolean;
}

/**
 * 输入与发送本来是一件事。
 *
 * 拆成「带边框的 textarea + 下面一排按钮」会让人用眼睛搬一次家，
 * 所以它们装在一个盒子里：写的地方无边框，发的地方是个圆点。
 */
export function Composer({
  session,
  agentLabel,
  draft,
  onDraftChange,
  onSend,
  onInterrupt,
  busy,
  error,
  large = false
}: Props) {
  const running = session.status === 'running';
  const canSend = draft.trim() !== '' && !busy;

  function send(): void {
    if (!canSend) return;
    onSend(draft.trim());
  }

  return (
    <div>
      {error ? <p className="mb-1 text-meta text-rust">{error}</p> : null}
      <div
        className={`rounded-md border border-hair bg-card py-2 focus-within:border-strong ${
          large ? 'px-3' : 'px-2.5'
        }`}
      >
        <textarea
          aria-label="发送消息"
          className={`w-full resize-none bg-transparent text-body text-primary outline-none placeholder:text-tertiary ${
            large ? 'min-h-[52px] max-h-56' : 'min-h-[44px] max-h-40'
          }`}
          placeholder="接着说…（⌘↵ 发送）"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-meta text-tertiary">
            {agentLabel} · {session.model === '' ? '默认模型' : session.model}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {running ? (
              <button
                aria-label="中断"
                className="grid size-6 place-items-center rounded-full border border-hair text-meta text-rust hover:border-rust"
                title="中断"
                onClick={onInterrupt}
              >
                ■
              </button>
            ) : null}
            <button
              aria-label="发送"
              className="grid size-6 place-items-center rounded-full bg-accent text-canvas disabled:opacity-30"
              title="发送（⌘↵）"
              disabled={!canSend}
              onClick={send}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
