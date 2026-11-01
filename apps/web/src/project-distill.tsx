import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memoryApi, type DistillSettingsDto } from './api.ts';

/**
 * 项目设置 · 会后提炼（ADR 0024）：选一个项目能用的已注册模型；不选 = 规则版。
 * hub 直接调这个模型（密钥不出 hub）；结果只进 staged / 待确认，不直接生效。
 */
export function ProjectDistill({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const key = ['memory', 'distill', projectId];
  const view = useQuery({ queryKey: key, queryFn: () => memoryApi.distill(projectId), retry: false });
  const models = useQuery({ queryKey: ['memory', 'distill-models', projectId], queryFn: () => memoryApi.distillModels(projectId), retry: false });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { model?: string | null; enabled?: boolean }) => memoryApi.setDistill(projectId, input),
    onSuccess: (next: DistillSettingsDto) => {
      setError(null);
      client.setQueryData(key, next);
    },
    onError: (e: Error) => setError(e.message)
  });
  const data = view.data;
  if (!data) return null;
  const options = (models.data ?? []).filter((provider) => provider.scope !== 'personal');
  const known = options.some((provider) => provider.models.some((model) => model.id === data.model));
  return (
    <section data-testid="project-distill" className="mb-4">
      <h3 className="mb-1 text-sub text-primary">会后提炼</h3>
      <p className="mb-2 text-meta text-tertiary">会话压缩后从摘要里提炼项目记忆。选了模型就由 hub 调它（按次计入该提供商用量）；不选用规则版。结果只进暂存 / 待确认。</p>
      <label className="mb-1 flex min-h-[44px] items-center gap-2 text-meta text-secondary">
        <input
          type="checkbox"
          data-testid="project-distill-enabled"
          className="h-5 w-5"
          checked={data.enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ enabled: e.target.checked })}
        />
        这个项目开启会后提炼
      </label>
      <label className="mb-1 flex flex-wrap items-center gap-2 text-meta text-secondary">
        提炼模型
        <select
          data-testid="project-distill-model"
          className="min-h-[36px] max-w-full rounded border border-hair bg-surface px-1 py-0.5"
          value={data.model ?? ''}
          disabled={save.isPending || !data.enabled}
          onChange={(e) => save.mutate({ model: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">规则版（不调模型）</option>
          {data.model && !known ? <option value={data.model}>{data.model}（现在不可用）</option> : null}
          {options.map((provider) => (
            <optgroup key={provider.slug} label={provider.name}>
              {provider.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {data.globalOff ? <p className="text-meta text-amber-500">全站已关闭提炼（HUB_MEMORY_DISTILL=0），这里的设置暂不生效。</p> : null}
      {error ? <p className="text-meta text-accent" role="alert">{error}</p> : null}
    </section>
  );
}
