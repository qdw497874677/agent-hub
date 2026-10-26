import { type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RequestFailed } from '../api.ts';
import { relativeTime } from '../workers.tsx';

export const INPUT =
  'w-full rounded-sm border border-hair bg-card px-2.5 py-2 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent';
export const SMALL =
  'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent disabled:opacity-40';
export const DANGER =
  'rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40';

export const at = (time: number | null | undefined) => relativeTime(time ?? undefined);
export const errorText = (error: unknown) => (error instanceof RequestFailed ? error.detail.message : '操作失败，再试一次');

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sub text-primary">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const Panel = ({ children }: { children: ReactNode }) => (
  <div className="rounded-md border border-hair bg-panel">{children}</div>
);
export const Empty = ({ text }: { text: string }) => <p className="px-3 py-4 text-meta text-tertiary">{text}</p>;

/** 写操作的通用外壳：成功后刷新后台数据，失败把服务端原话亮出来。 */
export function useAdminAction<T>(run: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] })
  });
}
