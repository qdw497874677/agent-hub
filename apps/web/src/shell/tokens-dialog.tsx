import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tokensApi, RequestFailed, type AccountDto, type ApiScopeDto, type ApiTokenDto } from './api.ts';
import { DialogShell } from './dialog-shell.tsx';
import { McpGuidePanel } from './mcp-guide.tsx';
import { maskToken } from '../atoms/mcp-guide.ts';
import { CopyButton, ManualCopy, useCopy } from '../atoms/copy.tsx';

/**
 * 每个 scope 一句人话 + 它实际带上的权限（detail 直接显示，不藏在悬停里）。
 * 本机 Worker 和 hub 管理权限永远不在这里（ADR 0014）。
 * assets:submit 是 assets:write 的旧名（权限完全一样），不再单列，老令牌照常可用。
 */
export const SCOPES: readonly { id: ApiScopeDto; label: string; hint: string; detail?: string; risky?: boolean }[] = [
  { id: 'projects:read', label: '读项目和任务', hint: '项目、任务、日志、改动' },
  { id: 'projects:write', label: '改项目和任务', hint: '建项目和任务，改状态，写日志', detail: '含删除项目' },
  { id: 'sessions:read', label: '读会话', hint: '会话详情、事件、实时流' },
  { id: 'sessions:write', label: '发起会话', hint: '开会话、发消息、打断、分叉', detail: '同时可以看和使用远程机器' },
  { id: 'workers:read', label: '看机器', hint: '可用的远程机器', detail: '本机永远不开放' },
  { id: 'providers:read', label: '查看模型提供商', hint: '已配置的提供商、模型和路由' },
  { id: 'providers:use', label: '使用模型提供商', hint: '看见并选用已配置的模型', detail: '不能管理提供商' },
  { id: 'providers:manage', label: '管理模型提供商', hint: '新建、改密钥、测连通、删除', detail: '不能给只限项目的令牌；记入审计', risky: true },
  { id: 'tokens:manage', label: '管理访问令牌', hint: '用 MCP / 开放 API 列出、签发、轮换、吊销令牌', detail: '不能给只限项目的令牌或 bot；签发的令牌不能再带 tokens:manage / providers:manage；记入审计', risky: true },
  { id: 'assets:read', label: '读资产', hint: '资产列表和内容（按你能看到的范围）' },
  { id: 'assets:write', label: '新建和更新资产', hint: '新建资产、交新版本', detail: '进审核队列，审核通过才可用' },
  { id: 'assets:publish', label: '自动发布与分配资产', hint: '跳过审核直接生效，并装到机器', detail: '同时可以看和使用机器、读项目；记入审计', risky: true },
  { id: 'groups:write', label: '在群里发言', hint: '往项目群里发消息', detail: '含接活；不能管理群成员' },
  { id: 'files:read', label: '读会话文件', hint: '只读会话工作目录里的文件', detail: '不能写、不能执行命令' },
  { id: 'memory:read', label: '读记忆', hint: '读取项目与团队记忆' },
  { id: 'memory:write', label: '写记忆', hint: '追加与修改记忆（含读）' }
];
/** 默认 30 天；永不过期放最后，选了会提示风险。 */
export const EXPIRY = [
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
  { label: '90 天', days: 90 },
  { label: '1 年', days: 365 },
  { label: '永不过期', days: 0 }
];
const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const errorText = (error: unknown) => (error instanceof RequestFailed ? error.detail.message : error ? "网络出错了，再试一次" : null);
const BTN = 'rounded-sm border border-hair px-3 py-2 text-sub text-secondary hover:border-strong hover:text-primary disabled:opacity-40';

/** 访问令牌：给脚本、CI、外部 agent 调开放 API / MCP 用。新建、列表、吊销；明文只显示一次。 */
export function TokensDialog({ me, onClose }: { me: AccountDto; onClose: () => void }) {
  return <DialogShell title="访问令牌" onClose={onClose}><TokenSettingsBody me={me} onClose={onClose} /></DialogShell>;
}

export function TokenSettings({ me }: { me: AccountDto }) {
  return <TokenSettingsBody me={me} />;
}

function TokenSettingsBody({ me, onClose }: { me: AccountDto; onClose?: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['api-tokens'], queryFn: tokensApi.list });
  const canService = me.role === 'owner' || me.clusterAdmin;
  const canGrantManage = me.clusterAdmin || me.role === 'owner' || me.role === 'admin';
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'service'>('personal');
  const [scopes, setScopes] = useState<ApiScopeDto[]>(['projects:read', 'sessions:read']);
  const [days, setDays] = useState(30);
  const [fresh, setFresh] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // 新令牌只显示一次：剪贴板写不进去时也不绕开遮罩，先让人点「显示」。
  const copies = useCopy(fresh ?? '');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
  const create = useMutation({
    mutationFn: () =>
      tokensApi.create({ name: name.trim(), kind, scopes, expiresAt: days ? Date.now() + days * 86_400_000 : null }),
    onSuccess: async (result) => {
      setFresh(result.token);
      copies.reset();
      setShown(false);
      setName('');
      await refresh();
    }
  });
  const revoke = useMutation({ mutationFn: tokensApi.revoke, onSuccess: refresh });
  const toggle = (id: ApiScopeDto) => {
    if ((id === 'providers:manage' || id === 'tokens:manage') && !canGrantManage) return;
    setScopes((old) => (old.includes(id) ? old.filter((s) => s !== id) : [...old, id]));
  };
  const tokens: ApiTokenDto[] = list.data ?? [];
  const active = tokens.filter((t) => t.revokedAt === null);
  return (
    <>
      <p className="text-sub text-primary">访问令牌</p>
      <p className="mt-1 text-meta text-tertiary" title="请求头 Authorization: Bearer ahp_…，可调开放 API 或 MCP；永远用不了本机机器">
        用于脚本和{' '}
        <a className="text-link underline-offset-2 hover:underline" href="/openapi/v1/docs" target="_blank" rel="noreferrer">
          API
        </a>
        ，权限不会超过你本人。
      </p>

      {fresh ? (
        <div data-testid="token-fresh" className="mt-4 rounded-sm border border-sage/50 bg-success-bg p-3">
          <p className="text-meta text-primary">新令牌只显示这一次，现在复制保存好：</p>
          <code data-testid="token-value" data-shown={shown} className="mt-2 block break-all rounded-sm bg-card px-2 py-1.5 font-mono text-[12px] text-primary select-all">
            {shown ? fresh : maskToken(fresh)}
          </code>
          <div className="mt-2 flex gap-2">
            <CopyButton action={copies} testId="token-copy" className={BTN} />
            <button data-testid="token-reveal" className={BTN} onClick={() => setShown((v) => !v)}>
              {shown ? '隐藏' : '显示'}
            </button>
            <button className={BTN} onClick={() => setFresh(null)}>
              我已保存
            </button>
          </div>
          {copies.manual ? (
            shown ? (
              <ManualCopy
                text={fresh}
                attempt={copies.attempts}
                testId="token-manual"
                label="没法写入剪贴板，下面是同一段令牌；已选中，可直接复制"
                className="mt-2"
              />
            ) : (
              <p data-testid="token-manual-masked" className="mt-2 text-meta text-tertiary">
                没法写入剪贴板；令牌还遮着，点「显示」后再手动复制。
              </p>
            )
          ) : null}
          <McpGuidePanel />
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
            className="w-full rounded-sm border border-hair bg-panel px-3 py-2 text-sub text-primary placeholder:text-tertiary focus:border-ring focus:outline-none"
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
                  className={`flex-1 rounded-sm border px-2 py-1.5 ${kind === value ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-secondary'}`}
                  onClick={() => setKind(value)}
                >
                  {value === 'personal' ? '个人令牌' : '团队服务账号'}
                </button>
              ))}
            </div>
          )}
          {kind === 'service' && <p className="-mt-1 text-[11px] text-tertiary">团队级令牌，不随个人离职失效。</p>}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-meta text-secondary">权限</legend>
            {SCOPES.map((scope) => {
              const manageLocked = (scope.id === 'providers:manage' || scope.id === 'tokens:manage') && !canGrantManage;
              return (
              <label key={scope.id} data-scope={scope.id} className={`flex items-start gap-2 rounded-sm px-1 py-1 ${manageLocked ? 'opacity-50' : 'cursor-pointer hover:bg-panel'}`}>
                <input type="checkbox" className="mt-1 accent-[var(--color-fg)]" checked={scopes.includes(scope.id)} disabled={manageLocked} onChange={() => toggle(scope.id)} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-meta text-primary">{scope.label}</span>
                    {scope.risky && <span className="rounded-sm bg-rust/15 px-1.5 py-0.5 text-[11px] text-rust">高风险</span>}
                  </span>
                  <span className="block text-[11px] text-tertiary">
                    {manageLocked ? '管理员可开' : `${scope.hint}${scope.detail ? `；${scope.detail}` : ''}`}
                  </span>
                </span>
              </label>
              );
            })}
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
          {days === 0 && (
            <p data-testid="token-forever-warning" className="-mt-1 text-[11px] text-rust">
              永不过期的令牌泄露后会一直有效，建议设个期限，到期再续。
            </p>
          )}
          {create.error && <p role="alert" className="text-meta text-rust">{errorText(create.error)}</p>}
          <button
            type="submit"
            data-testid="token-create"
            className="rounded-sm bg-action px-3 py-2.5 text-sub text-action-fg hover:bg-action/90 disabled:opacity-40"
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
                  {token.kind === 'service' && <span className="shrink-0 rounded-sm bg-info-bg px-1.5 py-0.5 text-[11px] text-info">服务账号</span>}
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
      {!fresh && (
        <details className="mt-5">
          <summary className="cursor-pointer text-meta text-secondary">外部智能体怎么接 MCP（Claude Code / Cursor / Codex / 提示词）</summary>
          <a data-testid="tokens-open-access" className="mt-2 block text-meta text-primary underline underline-offset-2 hover:text-secondary" href="#/access" onClick={onClose}>
            打开外部接入页：限定项目（含所在团队的资产）、测试连接、调用记录、轮换
          </a>
          <McpGuidePanel />
        </details>
      )}
    </>
  );
}
