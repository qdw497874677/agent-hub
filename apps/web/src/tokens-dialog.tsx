import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tokensApi, RequestFailed, type AccountDto, type ApiScopeDto, type ApiTokenDto } from './api.ts';
import { DialogShell } from './dialog-shell.tsx';

/** 每个 scope 一句人话；本机 Worker 和 hub 管理权限永远不在这里（ADR 0014）。 */
const SCOPES: readonly { id: ApiScopeDto; label: string; hint: string }[] = [
  { id: 'projects:read', label: '读项目和任务', hint: '项目、任务、工作日志、代码改动' },
  { id: 'projects:write', label: '改项目和任务', hint: '建项目 / 任务，改状态，写日志' },
  { id: 'sessions:read', label: '读对话', hint: '会话详情、事件、实时流' },
  { id: 'sessions:write', label: '发起对话', hint: '开会话、发消息、打断、分叉' },
  { id: 'workers:read', label: '看机器', hint: '可用的远程机器（本机永远不开放）' },
  { id: 'assets:submit', label: '提交资产新版本', hint: '只能给自己维护的资产提交新版本，进审核队列；不能批准、发布或安装' }
];
const EXPIRY = [
  { label: '永不过期', days: 0 },
  { label: '30 天', days: 30 },
  { label: '90 天', days: 90 },
  { label: '1 年', days: 365 }
];
const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const errorText = (error: unknown) => (error instanceof RequestFailed ? error.detail.message : error ? "网络出错了，再试一次" : null);
const BTN = 'rounded-sm border border-hair px-3 py-2 text-sub text-secondary hover:border-accent hover:text-accent disabled:opacity-40';

/** 访问令牌：给脚本、CI、外部 agent 调开放 API / MCP 用。新建、列表、吊销；明文只显示一次。 */
export function TokensDialog({ me, onClose }: { me: AccountDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['api-tokens'], queryFn: tokensApi.list });
  const canService = me.role === 'owner' || me.hubAdmin;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'service'>('personal');
  const [scopes, setScopes] = useState<ApiScopeDto[]>(['projects:read', 'sessions:read']);
  const [days, setDays] = useState(0);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
  const create = useMutation({
    mutationFn: () =>
      tokensApi.create({ name: name.trim(), kind, scopes, expiresAt: days ? Date.now() + days * 86_400_000 : null }),
    onSuccess: async (result) => {
      setFresh(result.token);
      setCopied(false);
      setName('');
      await refresh();
    }
  });
  const revoke = useMutation({ mutationFn: tokensApi.revoke, onSuccess: refresh });
  const toggle = (id: ApiScopeDto) => setScopes((old) => (old.includes(id) ? old.filter((s) => s !== id) : [...old, id]));
  const tokens: ApiTokenDto[] = list.data ?? [];
  const active = tokens.filter((t) => t.revokedAt === null);
  return (
    <DialogShell title="访问令牌" onClose={onClose}>
      <p className="text-sub text-primary">访问令牌</p>
      <p className="mt-1 text-meta text-tertiary">
        给脚本、CI 或外部 agent 用：<code className="text-secondary">Authorization: Bearer ahp_…</code> 调{' '}
        <a className="text-accent underline-offset-2 hover:underline" href="/openapi/v1/docs" target="_blank" rel="noreferrer">
          开放 API
        </a>{' '}
        或 MCP。令牌的权限不会超过你本人，也永远用不了 hub 本机。
      </p>

      {fresh ? (
        <div data-testid="token-fresh" className="mt-4 rounded-sm border border-accent/50 bg-accent/10 p-3">
          <p className="text-meta text-primary">新令牌只显示这一次，现在复制保存好：</p>
          <code data-testid="token-value" className="mt-2 block break-all rounded-sm bg-card px-2 py-1.5 font-mono text-[12px] text-primary select-all">
            {fresh}
          </code>
          <div className="mt-2 flex gap-2">
            <button
              className={BTN}
              onClick={() => {
                void navigator.clipboard?.writeText(fresh).then(() => setCopied(true));
              }}
            >
              {copied ? '已复制' : '复制'}
            </button>
            <button className={BTN} onClick={() => setFresh(null)}>
              我已保存
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-4 flex flex-col gap-3 rounded-sm border border-hair bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && scopes.length) create.mutate();
          }}
        >
          <input
            aria-label="令牌名称"
            data-testid="token-name"
            className="w-full rounded-sm border border-hair bg-panel px-3 py-2 text-sub text-primary placeholder:text-tertiary focus:border-accent focus:outline-none"
            placeholder="名称，例如 ci-bot"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {canService && (
            <div className="flex gap-2 text-meta" role="radiogroup" aria-label="令牌类型">
              {(['personal', 'service'] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  role="radio"
                  aria-checked={kind === value}
                  className={`flex-1 rounded-sm border px-2 py-1.5 ${kind === value ? 'border-accent text-accent' : 'border-hair text-secondary'}`}
                  onClick={() => setKind(value)}
                >
                  {value === 'personal' ? '个人令牌' : '团队服务账号'}
                </button>
              ))}
            </div>
          )}
          {kind === 'service' && <p className="-mt-1 text-[11px] text-tertiary">服务账号是团队里的一个独立成员（不占席位），人走了令牌照样能用。</p>}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-meta text-secondary">权限</legend>
            {SCOPES.map((scope) => (
              <label key={scope.id} className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1 hover:bg-panel">
                <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={scopes.includes(scope.id)} onChange={() => toggle(scope.id)} />
                <span className="min-w-0">
                  <span className="text-meta text-primary">{scope.label}</span>
                  <span className="block text-[11px] text-tertiary">{scope.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-meta text-secondary">
            有效期
            <select
              aria-label="有效期"
              className="flex-1 rounded-sm border border-hair bg-panel px-2 py-1.5 text-primary"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {EXPIRY.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {create.error && <p role="alert" className="text-meta text-rust">{errorText(create.error)}</p>}
          <button
            type="submit"
            data-testid="token-create"
            className="rounded-sm bg-accent px-3 py-2.5 text-sub text-white hover:opacity-90 disabled:opacity-40"
            disabled={create.isPending || !name.trim() || scopes.length === 0}
          >
            {create.isPending ? '生成中…' : '生成令牌'}
          </button>
        </form>
      )}

      <p className="mt-5 text-meta text-secondary">已有令牌（{active.length}）</p>
      {list.isPending ? (
        <p className="mt-2 text-meta text-tertiary">加载中…</p>
      ) : active.length === 0 ? (
        <p className="mt-2 text-meta text-tertiary">还没有令牌。</p>
      ) : (
        <ul className="mt-2 flex max-h-[40dvh] flex-col gap-2 overflow-y-auto">
          {active.map((token) => (
            <li key={token.id} data-testid="token-row" data-token-name={token.name} className="flex items-center gap-3 rounded-sm border border-hair bg-card px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-meta text-primary">
                  <span className="truncate">{token.name}</span>
                  {token.kind === 'service' && <span className="shrink-0 rounded-sm bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">服务账号</span>}
                  {!token.usable && <span className="shrink-0 rounded-sm bg-rust/15 px-1.5 py-0.5 text-[11px] text-rust">已过期</span>}
                </p>
                <p className="truncate font-mono text-[11px] text-tertiary">{token.prefix}…</p>
                <p className="truncate text-[11px] text-tertiary">
                  {token.scopes.length} 项权限 · {token.lastUsedAt ? `最近使用 ${when(token.lastUsedAt)}` : '从未使用'} ·{' '}
                  {token.expiresAt ? `${when(token.expiresAt)} 过期` : '永不过期'}
                </p>
              </div>
              <button
                data-testid="token-revoke"
                className="shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40"
                disabled={revoke.isPending}
                onClick={() => {
                  if (window.confirm(`吊销「${token.name}」？用它的脚本会立刻失效。`)) revoke.mutate(token.id);
                }}
              >
                吊销
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoke.error && <p role="alert" className="mt-2 text-meta text-rust">{errorText(revoke.error)}</p>}
    </DialogShell>
  );
}
