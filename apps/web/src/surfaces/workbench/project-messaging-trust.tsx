import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shell/api.ts';

/**
 * 项目设置 · 「信任同伴」（会话通信 P1f / P1e）：默认关——要审批的会话发给免审批的会话时，消息先拦下等人放行，
 * 免得借另一个 agent 绕过审批。打开后不再拦。只有能改项目的人能切（服务端同样把关）。
 */
export function ProjectMessagingTrust({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const key = ['messaging-trust', projectId];
  const data = useQuery({ queryKey: key, queryFn: () => api.messagingTrust(projectId) });
  const save = useMutation({
    mutationFn: (next: boolean) => api.setMessagingTrust(projectId, next),
    onSuccess: (next) => client.setQueryData(key, next)
  });
  const on = data.data?.trustPeers === true;
  return (
    <section className="mt-5 border-t border-hair pt-4" data-testid="project-messaging-trust">
      <h3 className="mb-1 text-sub text-primary">会话之间发消息</h3>
      <label className="flex min-h-9 cursor-pointer items-start gap-2 text-meta text-secondary">
        <input
          type="checkbox"
          data-testid="project-trust-peers"
          className="mt-0.5"
          checked={on}
          disabled={!data.isSuccess || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        <span>
          信任同伴：要审批的会话发给免审批的会话时不再拦下
          <span className="block text-tertiary">默认关。关着时这类消息会停在「被拦下」，由发起人或项目管理员放行。</span>
        </span>
      </label>
      {save.error ? <p className="text-meta text-rust" data-testid="project-trust-peers-error">{save.error.message}</p> : null}
    </section>
  );
}
