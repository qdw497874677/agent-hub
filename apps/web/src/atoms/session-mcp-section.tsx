import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionMcpApi, type SessionMcpServerDto, type SessionMcpViewDto } from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';

/**
 * 会话详情 · MCP 服务器。
 *
 * 一条会话启动时会把资产快照里的 MCP 清单发给 Worker；这里只管「这条会话不要哪几个」。
 * 改动只写会话上的名单，不重启进程、不动资产和机器安装——下次重新托管这条会话才生效，
 * 所以说明文字要说清楚，别让人以为拨完开关工具立刻就没了。
 *
 * 清单以 GET 为准：机器不在线 / 资产还没落到机器上时 `servers` 为空、`note` 说明原因；
 * 关掉的名单是会话自己的，仍照常显示（单独一组「已关掉但这次没出现」），也能直接打开。
 */
export function SessionMcp({ sessionId }: { sessionId: string }) {
  const client = useQueryClient();
  const key = sessionKeys.mcp(sessionId);
  const view = useQuery({
    queryKey: key,
    queryFn: () => sessionMcpApi.view(sessionId),
    staleTime: 15_000,
    retry: false
  });

  /** 乐观的关闭名单；回包落定后交还给查询缓存。 */
  const [override, setOverride] = useState<readonly string[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 检查器里切了会话：上一条会话的乐观状态不能带过去。
  useEffect(() => {
    setOverride(null);
    setSaving(null);
    setError(null);
  }, [sessionId]);

  const data = view.data ?? null;
  const disabled = override ?? data?.disabled ?? [];
  const servers = data?.servers ?? [];
  const listed = new Set(servers.map((server) => server.name));
  const missing = disabled.filter((name) => !listed.has(name));

  const toggle = async (name: string, on: boolean) => {
    const next = on ? disabled.filter((candidate) => candidate !== name) : [...disabled, name];
    setOverride(next);
    setSaving(name);
    setError(null);
    try {
      const updated = await sessionMcpApi.set(sessionId, next);
      client.setQueryData<SessionMcpViewDto>(key, (old) => (old ? { ...old, disabled: updated.mcpDisabled } : old));
      setOverride(null);
      // 会话 DTO 也带着 mcpDisabled：一起失效，别的面板（环境提醒等）跟着换。
      void client.invalidateQueries({ queryKey: ['session', sessionId] });
    } catch (failure) {
      setOverride(null);
      setError(failure instanceof Error && failure.message !== '' ? failure.message : '没保存成，过一会儿再试');
    } finally {
      setSaving(null);
    }
  };

  // 还在读：不占地方；真的一条都没有（清单和关闭名单都空，也没有要说的原因）也整段不渲染。
  if (view.isLoading) return null;
  if (data === null && view.error === null) return null;
  const empty = servers.length === 0 && missing.length === 0;
  const requestFailed = view.error !== null && data === null;
  if (empty && data?.note == null && error === null && !requestFailed) return null;

  // 清单为空时那一行说明：优先用 GET 给的机器上的原因；读不到清单就别装作机器上没有。
  const emptyReason = !empty || requestFailed ? (data?.note ?? null) : (data?.note ?? '这台机器上没有可下发的 MCP 资产。');

  return (
    <section data-testid="session-mcp" className="min-w-0">
      <p className="mb-0.5 text-meta text-tertiary">MCP 服务器</p>
      <p className="text-meta leading-[1.45] text-tertiary">只影响这条会话启动时下发的服务器；改完重启会话进程才生效。</p>

      {/* 一行说明清单为什么是空的：机器上的原因（没资产 / 没版本 / 还没落到机器上）由 GET 给；
          它没给原因时才自己说一句，不写「暂无」。 */}
      {emptyReason !== null ? (
        <p className="mt-1 text-meta text-tertiary" data-testid="session-mcp-note">
          {emptyReason}
        </p>
      ) : null}

      {servers.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              off={disabled.includes(server.name)}
              busy={saving === server.name}
              onToggle={(on) => void toggle(server.name, on)}
            />
          ))}
        </ul>
      ) : null}

      {missing.length > 0 ? (
        <div className="mt-2" data-testid="session-mcp-missing">
          <p className="mb-1 text-meta text-tertiary">已关掉但这次没出现</p>
          <ul className="space-y-1">
            {missing.map((name) => (
              <li
                key={name}
                data-testid="session-mcp-row"
                data-server={name}
                className="flex min-w-0 items-center gap-2 rounded-sm border border-dashed border-hair px-2 py-1.5 opacity-60"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-secondary" title={name}>
                  {name}
                </span>
                <Switch name={name} checked={false} busy={saving === name} onToggle={(on) => void toggle(name, on)} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {requestFailed ? (
        <p className="mt-1.5 text-meta text-tertiary">读不到这条会话的 MCP 清单，过一会儿再打开详情看看。</p>
      ) : null}
      {error !== null ? (
        <p role="alert" data-testid="session-mcp-error" className="mt-1.5 text-meta text-rust">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ServerRow({
  server,
  off,
  busy,
  onToggle
}: {
  readonly server: SessionMcpServerDto;
  readonly off: boolean;
  readonly busy: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  return (
    <li
      data-testid="session-mcp-row"
      data-server={server.name}
      data-disabled={off ? 'true' : 'false'}
      className={`min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 transition-opacity ${off ? 'opacity-50' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-mono text-meta text-primary" title={server.name}>
              {server.name}
            </span>
            <span
              className={`shrink-0 rounded-sm border px-1 font-mono text-[10px] leading-[15px] ${
                server.transport === 'http' ? 'border-strong text-primary' : 'border-hair text-secondary'
              }`}
            >
              {server.transport}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-meta text-tertiary" title={server.assetName}>
            来自 {server.assetName}
          </span>
        </span>
        <Switch name={server.name} checked={!off} busy={busy} onToggle={onToggle} />
      </div>
    </li>
  );
}

function Switch({
  name,
  checked,
  busy,
  onToggle
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly onToggle: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      data-testid="session-mcp-toggle"
      name={`MCP ${name}`}
      aria-label={`MCP ${name}`}
      checked={checked}
      disabled={busy}
      onChange={(event) => onToggle(event.target.checked)}
      className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-ring)] disabled:cursor-default disabled:opacity-40"
    />
  );
}
