import { useState, type ReactNode } from 'react';
import { Sheet } from '../../shell/dialog-shell.tsx';

/**
 * 窄屏的「工作区」抽屉：原来摊在输入框上方的那串东西（分支、改动数、仓库、添加仓库）
 * 收成一个自解释的入口。桌上的布局不变——那边一行放得下。
 *
 * 这里只做「看 + 复制 + 去该去的地方」：分支操作还在 git 对话框里（提交与推送…），
 * 加仓库还是原来那个 RepoSwitcher（它的「添加仓库」按钮原样搬进来），不改后端。
 */

/** 复制一段文字。优先剪贴板；http 访问内网时不是安全上下文，退回老办法。 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // 没授权 / 不是安全上下文：继续试 execCommand
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <button
      type="button"
      data-testid={testId}
      data-state={state}
      aria-live="polite"
      className="inline-flex min-h-[44px] shrink-0 items-center rounded-sm border border-hair px-3 text-meta text-secondary hover:border-strong hover:text-primary active:bg-card"
      onClick={() => {
        void copyText(value).then((ok) => setState(ok ? 'done' : 'failed'));
      }}
    >
      {state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </button>
  );
}

export function WorkspaceSheet({
  path,
  branch,
  isGit,
  ahead,
  changes,
  switcher,
  onOpenGit,
  onClose
}: {
  path: string | null;
  branch: string | null;
  /**
   * `true` 是 git、`false` 是确认过「不是 git 仓库」、`null` 是还没拿到结论
   * （查询在跑 / 离线 / 出错）。后者只敢说「暂未确认」，不能冒充不是 git。
   */
  isGit: boolean | null;
  ahead: number | null;
  changes: number | null;
  /** 仓库切换 + 添加仓库（RepoSwitcher 的原样节点，加仓库的入口靠它保持可达）。 */
  switcher: ReactNode;
  /** 打开 git 对话框：提交、推送、切分支都在那儿。 */
  onOpenGit: () => void;
  onClose: () => void;
}) {
  const branchText = isGit === true ? (branch ?? '分离 HEAD') : isGit === false ? '不是 git 仓库' : '暂未确认 Git 状态';
  const summary =
    isGit === true && changes !== null
      ? `${changes > 0 ? `${changes} 个未提交改动` : '没有未提交改动'}${ahead !== null && ahead > 0 ? ` · 领先远端 ${ahead} 个提交` : ''}`
      : null;
  return (
    <Sheet title="工作区" testId="workspace-sheet" onClose={onClose}>
      <div className="flex min-w-0 flex-col gap-4 px-4 pb-2">
        <section className="flex min-w-0 flex-col gap-1">
          <p className="text-meta text-tertiary">{isGit === true ? '当前分支' : '版本控制'}</p>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-sub text-primary"
              data-testid="workspace-branch"
              data-git={isGit === null ? 'unknown' : isGit ? 'yes' : 'no'}
              title={branchText}
            >
              {branchText}
            </span>
            {isGit === true && branch !== null ? <CopyButton value={branch} label="复制分支" testId="workspace-copy-branch" /> : null}
          </div>
          {summary === null ? null : (
            <p className="text-meta text-tertiary" data-testid="workspace-summary">
              {summary}
            </p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-1">
          <p className="text-meta text-tertiary">工作目录</p>
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 break-all font-mono text-meta text-secondary" data-testid="workspace-path">
              {path ?? '还没有工作目录'}
            </span>
            {path !== null ? <CopyButton value={path} label="复制路径" testId="workspace-copy-path" /> : null}
          </div>
        </section>

        {switcher === null || switcher === undefined ? null : (
          <section className="flex min-w-0 flex-col gap-1.5">
            <p className="text-meta text-tertiary">仓库</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-[44px]">{switcher}</div>
          </section>
        )}

        {/* 不知道是不是 git 时也留着入口：这是窄屏打开 git 对话框的唯一路径，
            真不是仓库的话对话框自己会说。 */}
        {isGit === false ? null : (
          <button
            type="button"
            data-testid="workspace-git"
            className="flex min-h-[44px] items-center justify-center rounded-sm border border-hair text-sub text-secondary hover:border-strong hover:text-primary active:bg-card"
            onClick={onOpenGit}
          >
            提交与推送…
          </button>
        )}
      </div>
    </Sheet>
  );
}
