import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from './icons.tsx';

/**
 * 列表刷新：只重取已经挂载的 query，不重挂载列表。
 *
 * 轮询负责「它自己会变」，这个按钮负责「我现在就要看」——所以走 refetchQueries，
 * 而不是等下一轮定时器。正在跑的那次请求不取消、也不重复发（cancelRefetch: false），
 * 于是连点两下也只会有一波请求。
 */
export function useRefresh(keys: readonly (readonly unknown[])[]): {
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // state 是异步的：连点时第二下可能还在同一帧里看到 busy=false，用 ref 兜住。
  const running = useRef(false);

  async function refresh(): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await Promise.all(
        keys.map((queryKey) =>
          client.refetchQueries({ queryKey, type: 'active' }, { cancelRefetch: false })
        )
      );
      // refetchQueries 默认不抛错，失败留在 query 自己身上；这里把失败翻出来给用户看。
      const broken = keys
        .flatMap((queryKey) => client.getQueryCache().findAll({ queryKey, type: 'active' }))
        .find((query) => query.state.status === 'error');
      setError(broken ? messageOf(broken.state.error) : null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return { busy, error, refresh };
}

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '请求没成功';
}

/** 安静的图标按钮：放进列表标题行，不抢主操作的位。手机 44px，桌面 32px。 */
export function RefreshButton({
  testId,
  label = '刷新',
  busy,
  error,
  onRefresh
}: {
  testId: string;
  /** 具体刷什么，读屏会念「刷新机器列表」而不是干巴巴的「刷新」。 */
  label?: string;
  busy: boolean;
  /** 失败时按钮仍在，再点一次就是重试；细节走 title / 读屏播报。 */
  error?: string | null;
  onRefresh: () => void;
}) {
  const hint = busy ? '正在刷新' : error ? `刷新失败，再点一次重试：${error}` : label;
  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        type="button"
        data-testid={testId}
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm text-tertiary hover:text-primary focus-visible:outline-2 disabled:cursor-progress disabled:opacity-60 md:min-h-0 md:min-w-0 md:size-8"
        title={hint}
        aria-label={hint}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => void onRefresh()}
      >
        <Icon
          name="refresh"
          className={
            busy
              ? 'animate-spin motion-reduce:animate-none'
              : error
                ? 'text-rust'
                : undefined
          }
        />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {busy ? '正在刷新' : error ? '刷新失败，可以再点一次重试' : ''}
      </span>
    </span>
  );
}
