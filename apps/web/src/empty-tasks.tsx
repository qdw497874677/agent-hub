/**
 * 项目里还没有任务时的提示：画布和列表共用一句话、一个按钮，说法保持一致。
 * 画布上居中悬浮（不挡平移/缩放），列表里就地显示。
 */
export function NoTasksHint({ onNewTask, floating = false }: { onNewTask: () => void; floating?: boolean }) {
  const body = (
    <div
      data-testid="no-tasks"
      className={
        floating
          ? 'pointer-events-auto max-w-sm rounded-md border border-hair bg-panel px-5 py-4 text-center shadow-sm'
          : 'flex flex-wrap items-center gap-3'
      }
    >
      <p className={`text-meta text-tertiary ${floating ? 'mb-3' : ''}`}>还没有任务。先写下想做的事，再从任务派生会话。</p>
      <button
        type="button"
        className="min-h-[44px] rounded-sm bg-accent px-4 text-meta text-canvas hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:min-h-0 md:py-1.5"
        onClick={onNewTask}
      >
        新建任务
      </button>
    </div>
  );
  if (!floating) return body;
  return <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">{body}</div>;
}
