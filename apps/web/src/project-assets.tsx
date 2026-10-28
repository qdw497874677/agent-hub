import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { assetsApi } from './api.ts';

const KIND_TEXT: Record<string, string> = { skill: '技能', instruction: '指令', mcp: 'MCP' };

/**
 * 项目设置 · 资产（asset-hub.md「项目级作用域」）：主人在这里决定这个项目的会话用哪些资产。
 * 全局的默认开；只属于这个项目的也默认开，同名时盖过全局的（就近优先）。成员看不到这一块。
 */
export function ProjectAssets({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const view = useQuery({ queryKey: ['admin', 'assets', 'project', projectId], queryFn: () => assetsApi.project(projectId) });
  const overview = useQuery({ queryKey: ['admin', 'assets'], queryFn: assetsApi.overview });
  const toggle = useMutation({
    mutationFn: (input: { assetId: string; enabled: boolean | null }) => assetsApi.setProject(projectId, input.assetId, input.enabled),
    onSettled: () => client.invalidateQueries({ queryKey: ['admin', 'assets', 'project', projectId] })
  });
  const byId = new Map((overview.data?.assets ?? []).map((asset) => [asset.id, asset]));
  const choices = view.data?.choices ?? [];
  return (
    <section data-testid="project-assets" className="mb-4">
      <h3 className="mb-1 text-sub text-primary">资产</h3>
      <p className="mb-2 text-meta text-tertiary">
        这个项目的新会话用哪些技能、指令和 MCP。全局的默认开；只属于本项目的同名时优先。还要装在会话所在的机器上才会生效。
      </p>
      {view.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      {view.data && choices.length === 0 ? <p className="text-meta text-tertiary">还没有资产，去「管理 · 资产」添加。</p> : null}
      <ul className="space-y-1">
        {choices.map((choice) => {
          const asset = byId.get(choice.assetId);
          const shadow = choice.shadowedBy ? byId.get(choice.shadowedBy) : undefined;
          return (
            <li
              key={choice.assetId}
              data-testid="project-asset"
              data-name={asset?.name ?? choice.assetId}
              className="flex items-center gap-2 rounded-sm border border-hair px-2 py-1.5"
            >
              <input
                type="checkbox"
                aria-label={`在这个项目里用 ${asset?.name ?? choice.assetId}`}
                checked={choice.enabled}
                disabled={toggle.isPending}
                onChange={(event) => toggle.mutate({ assetId: choice.assetId, enabled: event.target.checked })}
              />
              <span className="rounded border border-strong px-1 text-meta text-secondary">{KIND_TEXT[asset?.kind ?? ''] ?? '资产'}</span>
              <span className="min-w-0 flex-1 truncate text-sub text-primary">{asset?.name ?? choice.assetId}</span>
              <span className={`text-meta ${choice.scope === 'project' ? 'text-accent' : 'text-tertiary'}`}>
                {choice.scope === 'project' ? '本项目' : '全局'}
              </span>
              {shadow && choice.enabled ? <span className="text-meta text-tertiary">被本项目的同名资产盖过</span> : null}
              {choice.overridden ? (
                <button className="text-meta text-tertiary underline" onClick={() => toggle.mutate({ assetId: choice.assetId, enabled: null })}>
                  恢复默认
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {toggle.error ? <p className="mt-1 text-meta text-rust">{(toggle.error as Error).message}</p> : null}
    </section>
  );
}
