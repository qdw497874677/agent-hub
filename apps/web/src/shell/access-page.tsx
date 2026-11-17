import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, mcpAccessApi, tokensApi, type ApiScopeDto, type ApiTokenDto } from './api.ts';
import { AccountMenu, useAccount } from './auth.tsx';
import { formatRoute } from './route.ts';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel, Empty } from './admin/shared.tsx';
import { McpGuidePanel } from './mcp-guide.tsx';
import { EXPIRY, SCOPES } from './tokens-dialog.tsx';
import { maskToken, mcpGuide } from '../atoms/mcp-guide.ts';
import { TOKEN_PRESETS, activityLabel, presetOf, testMcpConnection, type TokenPresetId } from '../atoms/token-presets.ts';

/** 到期是将来的时间，相对时间（「刚刚」）只适合过去，这里写绝对日期。 */
const day = (ms: number) => new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });

/**
 * 外部接入（MCP）页（#/access）：给 Claude Code / Cursor / Codex 这类外部 agent 接 hub。
 * 一页说清：端点、写工具开关、接入片段、令牌（预设权限、限定项目、默认 30 天、明文只给一次）、
 * 测试连接、令牌列表（最近使用、能用几个工具、调用记录、轮换、吊销后记录保留）。
 */
const KEY = ['api-tokens'] as const;

function WritesSwitch() {
  const client = useQueryClient();
  const access = useQuery({ queryKey: ['mcp-access'], queryFn: mcpAccessApi.get });
  const set = useMutation({
    mutationFn: mcpAccessApi.set,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['mcp-access'] });
      await client.invalidateQueries({ queryKey: KEY });
    }
  });
  const data = access.data;
  if (!data) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid="access-writes">
      <span className="min-w-0 flex-1">
        <span className="block text-body text-primary">允许外部 agent 写</span>
        <span className="block text-meta text-tertiary">
          建任务、发起会话、补话、打断。{data.writes ? '已开启' : '已关闭'}
          {data.source === 'env' ? '（沿用服务器默认）' : ''}
        </span>
      </span>
      {data.canManage ? (
        <button
          role="switch"
          aria-checked={data.writes}
          data-testid="access-writes-toggle"
          disabled={set.isPending}
          className={`rounded-full border px-3 py-1 text-meta ${data.writes ? 'border-accent bg-accent/10 text-accent' : 'border-hair text-secondary'}`}
          onClick={() => set.mutate(!data.writes)}
        >
          {data.writes ? '开' : '关'}
        </button>
      ) : (
        <span className="text-meta text-tertiary">管理员可改</span>
      )}
      {set.error ? <p className="w-full text-meta text-rust">{errorText(set.error)}</p> : null}
    </div>
  );
}

function FreshToken({ token, onDone }: { token: string; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const url = mcpGuide({ origin: window.location.origin }).url;
  return (
    <div data-testid="token-fresh" className="rounded-md border border-accent/50 bg-accent/10 p-3">
      <p className="text-meta text-primary">新令牌只显示这一次，现在复制保存好：</p>
      <code data-testid="token-value" className="mt-2 block break-all rounded-sm bg-card px-2 py-1.5 font-mono text-[12px] text-primary select-all">
        {shown ? token : maskToken(token)}
      </code>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={SMALL} onClick={() => void navigator.clipboard?.writeText(token).then(() => setCopied(true))}>
          {copied ? '已复制' : '复制'}
        </button>
        <button data-testid="token-reveal" className={SMALL} onClick={() => setShown((v) => !v)}>
          {shown ? '隐藏' : '显示'}
        </button>
        <button
          data-testid="token-test"
          className={SMALL}
          onClick={() => {
            setTested(null);
            testMcpConnection(url, token)
              .then((count) => setTested({ ok: true, text: `连上了，能用 ${count} 个工具` }))
              .catch((error: unknown) => setTested({ ok: false, text: error instanceof Error ? error.message : '连不上' }));
          }}
        >
          测试连接
        </button>
        <button className={SMALL} onClick={onDone}>
          我已保存
        </button>
      </div>
      {tested ? (
        <p data-testid="token-test-result" className={`mt-2 text-meta ${tested.ok ? 'text-sage' : 'text-rust'}`}>
          {tested.text}
        </p>
      ) : null}
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: (token: string) => void }) {
  const client = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScopeDto[]>([...TOKEN_PRESETS[0]!.scopes]);
  const [preset, setPreset] = useState<TokenPresetId>('readonly');
  const [limit, setLimit] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const create = useMutation({
    mutationFn: () =>
      tokensApi.create({
        name: name.trim(),
        kind: 'personal',
        scopes,
        expiresAt: days ? Date.now() + days * 86_400_000 : null,
        projectIds: limit ? picked : null
      }),
    onSuccess: async (result) => {
      setName('');
      onCreated(result.token);
      await client.invalidateQueries({ queryKey: KEY });
    }
  });
  const choose = (id: TokenPresetId) => {
    setPreset(id);
    const found = TOKEN_PRESETS.find((p) => p.id === id);
    if (found && id !== 'custom') setScopes([...found.scopes]);
  };
  const toggle = (id: ApiScopeDto) => {
    const next = scopes.includes(id) ? scopes.filter((s) => s !== id) : [...scopes, id];
    setScopes(next);
    setPreset(presetOf(next) === 'custom' ? 'custom' : presetOf(next));
  };
  const ready = name.trim() !== '' && scopes.length > 0 && (!limit || picked.length > 0);
  return (
    <form
      data-testid="access-create"
      className="flex flex-col gap-3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
    >
      <input aria-label="令牌名称" data-testid="token-name" className={INPUT} placeholder="名称，例如 claude-code-笔记本" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <div role="radiogroup" aria-label="权限预设" className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {TOKEN_PRESETS.map((p) => (
          <button
            type="button"
            key={p.id}
            role="radio"
            aria-checked={preset === p.id}
            data-testid="token-preset"
            data-preset={p.id}
            className={`rounded-sm border px-2 py-1.5 text-left ${preset === p.id ? 'border-accent bg-accent/10' : 'border-hair hover:border-strong'}`}
            onClick={() => choose(p.id)}
          >
            <span className="block text-meta text-primary">{p.label}</span>
            <span className="block text-[11px] text-tertiary">{p.hint}</span>
          </button>
        ))}
      </div>
      {preset === 'custom' ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-meta text-secondary">权限</legend>
          {SCOPES.map((scope) => (
            <label key={scope.id} data-scope={scope.id} className="flex cursor-pointer items-start gap-2 rounded-sm px-1 py-1 hover:bg-card">
              <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={scopes.includes(scope.id)} onChange={() => toggle(scope.id)} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-meta text-primary">{scope.label}</span>
                  {scope.risky ? <span className="rounded-sm bg-rust/15 px-1.5 py-0.5 text-[11px] text-rust">高风险</span> : null}
                </span>
                <span className="block text-[11px] text-tertiary">
                  {scope.hint}
                  {scope.detail ? `；${scope.detail}` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-meta text-secondary">
          <input type="checkbox" data-testid="token-limit-projects" className="accent-[var(--color-accent)]" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
          只给指定项目
        </label>
        {limit ? (
          <div className="flex flex-wrap gap-1.5" data-testid="token-projects">
            {(projects.data ?? []).map((project) => {
              const on = picked.includes(project.id);
              return (
                <button
                  type="button"
                  key={project.id}
                  aria-pressed={on}
                  data-testid="token-project"
                  className={`rounded-full border px-2.5 py-1 text-meta ${on ? 'border-accent bg-accent/10 text-primary' : 'border-hair text-tertiary'}`}
                  onClick={() => setPicked((old) => (on ? old.filter((id) => id !== project.id) : [...old, project.id]))}
                >
                  {project.name}
                </button>
              );
            })}
            {picked.length === 0 ? <span className="text-[11px] text-tertiary">至少选一个；选了之后，这个令牌碰不到别的项目，也不能新建项目。</span> : null}
          </div>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-meta text-secondary">
        有效期
        <select aria-label="有效期" className="flex-1 rounded-sm border border-hair bg-card px-2 py-1.5 text-primary" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {EXPIRY.map((option) => (
            <option key={option.days} value={option.days}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {days === 0 ? <p className="-mt-1 text-[11px] text-rust">永不过期的令牌泄露后会一直有效，建议设个期限，到期再续。</p> : null}
      {create.error ? <p role="alert" className="text-meta text-rust">{errorText(create.error)}</p> : null}
      <button type="submit" data-testid="token-create" className="rounded-sm bg-accent px-3 py-2.5 text-sub text-white hover:opacity-90 disabled:opacity-40" disabled={!ready || create.isPending}>
        {create.isPending ? '生成中…' : '生成令牌'}
      </button>
    </form>
  );
}

function TokenRow({ token, projectName, onRotated }: { token: ApiTokenDto; projectName: (id: string) => string; onRotated: (raw: string) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const tools = useQuery({ queryKey: [...KEY, token.id, 'tools'], queryFn: () => tokensApi.tools(token.id), enabled: token.revokedAt === null });
  const activity = useQuery({ queryKey: [...KEY, token.id, 'activity'], queryFn: () => tokensApi.activity(token.id), enabled: open });
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  const revoke = useMutation({ mutationFn: () => tokensApi.revoke(token.id), onSuccess: refresh });
  const rotate = useMutation({
    mutationFn: () => tokensApi.rotate(token.id),
    onSuccess: async (result) => {
      onRotated(result.token);
      await refresh();
    }
  });
  const revoked = token.revokedAt !== null;
  const scope = token.projectIds?.length ? `限 ${token.projectIds.map(projectName).join('、')}` : '所有项目';
  return (
    <li data-testid="token-row" data-token-name={token.name} data-revoked={revoked ? 'true' : undefined} className="border-b border-hair px-3 py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`min-w-0 truncate text-body ${revoked ? 'text-tertiary line-through' : 'text-primary'}`}>{token.name}</span>
        {token.kind === 'service' ? <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">服务账号</span> : null}
        {revoked ? <span className="rounded-sm bg-card px-1.5 py-0.5 text-[11px] text-tertiary">已吊销</span> : !token.usable ? <span className="rounded-sm bg-rust/15 px-1.5 py-0.5 text-[11px] text-rust">已过期</span> : null}
        <span className="ml-auto font-mono text-[11px] text-tertiary">{token.prefix}…</span>
      </div>
      <p className="mt-0.5 text-meta text-tertiary">
        {scope} · {token.lastUsedAt ? `最近使用 ${at(token.lastUsedAt)}` : '从未使用'} ·{' '}
        {revoked ? `吊销于 ${at(token.revokedAt)}` : token.expiresAt ? `${day(token.expiresAt)} 到期` : '永不过期'}
        {tools.data ? (
          <span data-testid="token-tools">
            {' '}
            · 能用 {tools.data.tools.length} 个工具
          </span>
        ) : null}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button className={SMALL} data-testid="token-activity" onClick={() => setOpen((v) => !v)}>
          {open ? '收起记录' : '调用记录'}
        </button>
        {!revoked && token.kind !== 'bot' ? (
          <button
            className={SMALL}
            data-testid="token-rotate"
            disabled={rotate.isPending}
            onClick={() => {
              if (window.confirm(`轮换「${token.name}」？会生成新令牌，旧的立刻失效。`)) rotate.mutate();
            }}
          >
            轮换
          </button>
        ) : null}
        {!revoked ? (
          <button
            className={DANGER}
            data-testid="token-revoke"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(`吊销「${token.name}」？用它的脚本会立刻失效。`)) revoke.mutate();
            }}
          >
            吊销
          </button>
        ) : null}
      </div>
      {open ? (
        <ul data-testid="token-activity-list" className="mt-2 flex flex-col gap-0.5 rounded-sm bg-card px-2 py-1.5">
          {activity.data?.length ? (
            activity.data.map((row, index) => (
              <li key={index} className="flex gap-2 text-meta">
                <span className="shrink-0 text-tertiary">{at(row.at)}</span>
                <span className="shrink-0 text-secondary">{activityLabel(row.action)}</span>
                <span className="min-w-0 break-words text-primary">{row.action === 'mcp.call' ? row.detail : ''}</span>
              </li>
            ))
          ) : (
            <li className="text-meta text-tertiary">{activity.isLoading ? '加载中…' : '还没有记录'}</li>
          )}
        </ul>
      ) : null}
      {revoke.error || rotate.error ? <p className="mt-1 text-meta text-rust">{errorText(revoke.error ?? rotate.error)}</p> : null}
    </li>
  );
}

export function AccessPage() {
  const account = useAccount();
  const list = useQuery({ queryKey: KEY, queryFn: tokensApi.list, enabled: !!account });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: !!account });
  const [fresh, setFresh] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  if (!account) return null;
  const tokens = (list.data ?? []).filter((t) => t.kind !== 'bot');
  const active = tokens.filter((t) => t.revokedAt === null);
  const revoked = tokens.filter((t) => t.revokedAt !== null);
  const projectName = (id: string) => (projects.data ?? []).find((p) => p.id === id)?.name ?? '已删除的项目';
  const url = mcpGuide({ origin: window.location.origin }).url;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-hair px-3 py-2">
        <div className="min-w-0">
          <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'home' })}>
            ← agent-hub
          </a>
          <h1 className="text-head text-primary">外部接入（MCP）</h1>
        </div>
        <AccountMenu />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto flex max-w-[960px] flex-col">
          <Section title="端点">
            <Panel>
              <p className="px-3 pt-2.5 text-meta text-tertiary">外部 agent 用这个地址接 hub，令牌放在请求头里。</p>
              <code data-testid="access-endpoint" className="mx-3 mt-1 mb-2 block select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-[12px] text-primary">
                {url}
              </code>
              <div className="border-t border-hair">
                <WritesSwitch />
              </div>
            </Panel>
          </Section>
          <Section title="新建令牌">
            <Panel>{fresh ? <div className="p-3"><FreshToken token={fresh} onDone={() => setFresh(null)} /></div> : <CreateForm onCreated={setFresh} />}</Panel>
          </Section>
          <Section title="接到客户端">
            <McpGuidePanel />
          </Section>
          <Section title={`令牌（${active.length}）`}>
            <Panel>
              {list.isPending ? (
                <Empty text="加载中…" />
              ) : active.length === 0 ? (
                <Empty text="还没有令牌。" />
              ) : (
                <ul data-testid="access-tokens">
                  {active.map((token) => (
                    <TokenRow key={token.id} token={token} projectName={projectName} onRotated={setFresh} />
                  ))}
                </ul>
              )}
            </Panel>
            {revoked.length ? (
              <div className="mt-2">
                <button className="text-meta text-tertiary hover:text-secondary" data-testid="access-show-revoked" onClick={() => setShowRevoked((v) => !v)}>
                  {showRevoked ? '收起已吊销' : `已吊销（${revoked.length}）`}
                </button>
                {showRevoked ? (
                  <Panel>
                    <ul data-testid="access-revoked">
                      {revoked.map((token) => (
                        <TokenRow key={token.id} token={token} projectName={projectName} onRotated={setFresh} />
                      ))}
                    </ul>
                  </Panel>
                ) : null}
              </div>
            ) : null}
          </Section>
        </div>
      </main>
    </div>
  );
}
