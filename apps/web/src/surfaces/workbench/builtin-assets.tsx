import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BUILTIN_KIND_TEXT, browserSummary, builtinAction, missingSecrets } from '../../atoms/builtin-assets.ts';
import { builtinApi, type BuiltinAssetDto } from '../../shell/api.ts';
import { BuiltinBadge } from '../../shell/builtin-badge.tsx';
import { SMALL_BUTTON } from '../../shell/dialog-shell.tsx';

const PRIMARY = 'shrink-0 rounded-control bg-action px-2.5 py-1 text-meta font-medium text-action-fg hover:bg-action/90 disabled:opacity-40';
const INPUT = 'min-w-0 flex-1 rounded-sm border border-hair bg-card px-2 py-1 text-meta text-primary';
const errorText = (error: unknown) => (error instanceof Error ? error.message : '出错了');

/** 给机器装 Chromium（Playwright 要用）：只有集群管理员看得到机器清单和按钮。 */
function BrowserRow() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['builtin', 'browser'],
    queryFn: builtinApi.browser,
    refetchInterval: (query) => (query.state.data?.workers.some((worker) => worker.installing) ? 3000 : false)
  });
  const install = useMutation({
    mutationFn: builtinApi.installBrowser,
    onSettled: () => client.invalidateQueries({ queryKey: ['builtin', 'browser'] })
  });
  const data = status.data;
  if (!data?.canInstall) return <p className="mt-1 text-meta text-tertiary">要用浏览器的机器得先装 Chromium，请管理员在这里装。</p>;
  return (
    <div data-testid="builtin-browser" className="mt-1.5 rounded-sm bg-card px-2 py-1.5">
      <p className="text-meta text-secondary">{browserSummary(data.workers)}</p>
      <ul className="mt-1 space-y-1">
        {data.workers.map((worker) => (
          <li key={worker.workerId} className="flex flex-wrap items-center gap-2 text-meta" data-worker={worker.workerId}>
            <span className="min-w-0 flex-1 truncate text-primary">{worker.label}</span>
            {worker.ready ? (
              <span className="text-sage">已装好</span>
            ) : worker.installing ? (
              <span className="text-tertiary">正在安装…</span>
            ) : worker.blocker ? (
              <span className="text-tertiary">{worker.blocker}</span>
            ) : (
              <button data-testid="builtin-browser-install" className={SMALL_BUTTON} disabled={install.isPending} onClick={() => install.mutate(worker.workerId)}>
                安装 Chromium
              </button>
            )}
          </li>
        ))}
      </ul>
      {install.error ? <p className="mt-1 text-meta text-rust">{errorText(install.error)}</p> : null}
    </div>
  );
}

function BuiltinRow({ item, projectId }: { item: BuiltinAssetDto; projectId: string }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['builtin', projectId] });
    await client.invalidateQueries({ queryKey: ['admin', 'assets'] });
  };
  const enable = useMutation({
    mutationFn: (secrets?: Record<string, string>) => builtinApi.enable(item.id, projectId, secrets),
    onSuccess: async () => {
      setAsking(false);
      setValues({});
      await refresh();
    }
  });
  const update = useMutation({ mutationFn: () => builtinApi.update(item.enabled?.assetId ?? ''), onSuccess: refresh });
  const action = builtinAction(item);
  const missing = missingSecrets(item);
  const ready = missing.every((secret) => (values[secret.name] ?? '').trim() !== '');
  return (
    <li data-testid="builtin-asset" data-id={item.id} data-state={action} className="rounded-sm border border-hair px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-strong px-1 text-meta text-secondary">{BUILTIN_KIND_TEXT[item.kind]}</span>
        <span className="min-w-0 truncate text-sub text-primary">{item.title}</span>
        <BuiltinBadge version={item.version} />
        <span className="ml-auto flex items-center gap-2">
          {action === 'enable' ? (
            <button data-testid="builtin-enable" className={PRIMARY} disabled={enable.isPending} onClick={() => enable.mutate(undefined)}>
              {enable.isPending ? '启用中…' : '启用'}
            </button>
          ) : action === 'secrets' ? (
            <button data-testid="builtin-enable" className={PRIMARY} onClick={() => setAsking((v) => !v)}>
              启用
            </button>
          ) : action === 'update' ? (
            <>
              <span data-testid="builtin-enabled" className="text-meta text-sage">已启用 · {item.enabled?.version}</span>
              <button data-testid="builtin-update" className={SMALL_BUTTON} disabled={update.isPending} onClick={() => update.mutate()}>
                更新到 {item.enabled?.update}
              </button>
            </>
          ) : action === 'enabled' ? (
            <span data-testid="builtin-enabled" className="text-meta text-sage">已启用</span>
          ) : action === 'off' ? (
            <button data-testid="builtin-enable" className={SMALL_BUTTON} disabled={enable.isPending} onClick={() => enable.mutate(undefined)}>
              重新打开
            </button>
          ) : null}
        </span>
      </div>
      <p className="mt-0.5 text-meta text-secondary">{item.summary}</p>
      <p className="mt-0.5 text-[11px] text-tertiary">
        <a className="underline hover:text-secondary" href={item.source.url} target="_blank" rel="noreferrer">
          {item.source.label}
        </a>{' '}
        · {item.source.license}
        {item.note ? ` · ${item.note}` : ''}
        {item.secrets.length ? ` · 要 ${item.secrets.map((s) => s.label).join('、')}` : ''}
      </p>
      {item.clash ? <p className="mt-0.5 text-meta text-tertiary">{item.clash}，不能再启用内置的</p> : null}
      {item.requiresBrowser ? <BrowserRow /> : null}
      {asking && action === 'secrets' ? (
        <form
          data-testid="builtin-secrets"
          className="mt-1.5 flex flex-col gap-1.5 rounded-sm bg-card px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) enable.mutate(Object.fromEntries(missing.map((secret) => [secret.name, (values[secret.name] ?? '').trim()])));
          }}
        >
          {missing.map((secret) => (
            <label key={secret.name} className="flex flex-col gap-1 text-meta text-secondary">
              <span>
                {secret.label}
                {secret.url ? (
                  <>
                    {' · '}
                    <a className="underline hover:text-primary" href={secret.url} target="_blank" rel="noreferrer">
                      去拿
                    </a>
                  </>
                ) : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                aria-label={secret.label}
                data-testid="builtin-secret-input"
                className={INPUT}
                value={values[secret.name] ?? ''}
                onChange={(event) => setValues((old) => ({ ...old, [secret.name]: event.target.value }))}
              />
              <span className="text-[11px] text-tertiary">{secret.hint}。存成团队密钥，填进去就读不回来。</span>
            </label>
          ))}
          <div className="flex gap-2">
            <button type="submit" data-testid="builtin-secret-save" className={PRIMARY} disabled={!ready || enable.isPending}>
              {enable.isPending ? '启用中…' : '保存并启用'}
            </button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setAsking(false)}>
              取消
            </button>
          </div>
        </form>
      ) : null}
      {enable.error || update.error ? <p role="alert" className="mt-1 text-meta text-rust">{errorText(enable.error ?? update.error)}</p> : null}
    </li>
  );
}

/**
 * 项目设置 · 内置资产：Hub 自带、版本锁定，一键启用到这个项目（项目里的 Bot 也会用上）。
 * 要密钥的先填密钥；要浏览器的提示装 Chromium；hub 升级带来新版本时只提示，点了才换。
 */
export function BuiltinAssets({ projectId }: { projectId: string }) {
  const list = useQuery({ queryKey: ['builtin', projectId], queryFn: () => builtinApi.list(projectId), retry: false });
  if (list.error) return null;
  return (
    <section data-testid="builtin-assets" className="mb-4">
      <h3 className="mb-0.5 text-sub text-primary">内置资产</h3>
      <p className="mb-2 text-meta text-tertiary">Hub 自带，版本已锁定。启用后这个项目的会话（含项目里的 Bot）都能用。</p>
      {list.isLoading ? <p className="text-meta text-tertiary">加载中…</p> : null}
      <ul className="space-y-1.5">
        {(list.data ?? []).map((item) => (
          <BuiltinRow key={item.id} item={item} projectId={projectId} />
        ))}
      </ul>
    </section>
  );
}
