import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionMcpApi, type SessionMcpServerDto, type SessionMcpViewDto } from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';

/**
 * 会话详情 · MCP 服务器。
 *
 * 一条会话启动时会把资产快照里的 MCP 清单发给 Worker；这里只管「这条会话不要哪几个」。
 * 清单是模板给的（资产快照），这里只能做减法——加不进来。
 *
 * 所以这节的首行永远是当前状态，而不是一句「暂无」：
 * 读取中 / 读不到（接口失败）/ 无（这台机器上没有资产，原因来自 GET）/ n 个。
 * 每条也只说「启动时下发」和「这次不加载」，不说「已生效」：正在跑的进程仍按它启动时的快照。
 * 改动只写会话上的名单，不重启进程、不动资产和机器安装——下次重新托管才生效。
 *
 * 手机上整段收成一行摘要（标题 + 已确认的「n 个 · 关掉 k 个」），点开才是清单；桌面默认展开。
 * 摘要不跟乐观值走，正在写的时候另加「保存中」。
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
  /** 失败的那一次改动：重试必须是「同一行、同一个方向」，不能拿当前勾选状态猜。 */
  const [failed, setFailed] = useState<{ name: string; on: boolean } | null>(null);
  /** 手机上一行摘要、桌面直接摊开：清单长的时候不该把首屏全占了。 */
  const [open, setOpen] = useState(desktopExpanded);
  /** 会话切换会让在途请求作废；旧回包的 finally 不能把新会话的写闸门打开。 */
  const seq = useRef(0);

  // 检查器里切了会话：上一条会话的乐观状态不能带过去。
  useEffect(() => {
    seq.current += 1;
    setOverride(null);
    setSaving(null);
    setError(null);
    setFailed(null);
  }, [sessionId]);

  const data = view.data ?? null;
  const disabled = override ?? data?.disabled ?? [];
  const servers = data?.servers ?? [];
  const listed = new Set(servers.map((server) => server.name));
  const missing = disabled.filter((name) => !listed.has(name));

  const toggle = async (name: string, on: boolean) => {
    if (saving !== null) return; // 串行：一次只写一条，避免后回的包盖掉前一条
    const token = ++seq.current;
    const next = on ? disabled.filter((candidate) => candidate !== name) : [...disabled, name];
    setOverride(next);
    setSaving(name);
    setError(null);
    setFailed(null);
    try {
      const updated = await sessionMcpApi.set(sessionId, next);
      if (token !== seq.current) return;
      client.setQueryData<SessionMcpViewDto>(key, (old) => (old ? { ...old, disabled: updated.mcpDisabled } : old));
      setOverride(null);
      // 会话 DTO 也带着 mcpDisabled：一起失效，别的面板（环境提醒等）跟着换。
      void client.invalidateQueries({ queryKey: ['session', sessionId] });
    } catch (failure) {
      if (token !== seq.current) return;
      setOverride(null);
      setFailed({ name, on });
      setError(failure instanceof Error && failure.message !== '' ? failure.message : '没保存成，过一会儿再试');
    } finally {
      if (token === seq.current) setSaving(null);
    }
  };

  const empty = servers.length === 0 && missing.length === 0;
  const requestFailed = view.error !== null && data === null;
  const loading = view.isLoading;
  // 清单为空时那一行说明：优先用 GET 给的机器上的原因（「没有 MCP 服务器…」）；读不到清单就别装作机器上没有。
  const emptyReason = loading || requestFailed ? null : (data?.note ?? (empty ? '这台机器上没有可下发的 MCP 资产。' : null));
  // 摘要报服务端已确认的名单；正在写的时候另加「保存中」，不把乐观值说成已生效。
  const confirmedOff = servers.filter((server) => (data?.disabled ?? []).includes(server.name)).length;
  const confirmedText =
    servers.length === 0 ? '无' : `${servers.length} 个${confirmedOff > 0 ? ` · 关掉 ${confirmedOff} 个` : ''}`;
  const summary = loading ? '读取中…' : requestFailed ? '读不到' : saving === null ? confirmedText : `${confirmedText} · 保存中…`;

  return (
    <details
      data-testid="session-mcp"
      aria-labelledby={`session-mcp-title-${sessionId}`}
      className="group/mcp min-w-0"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 md:min-h-0">
        <span aria-hidden className="inline-block w-2.5 shrink-0 text-center text-tertiary transition-transform group-open/mcp:rotate-90">
          ›
        </span>
        <span id={`session-mcp-title-${sessionId}`} className="shrink-0 text-meta text-secondary">
          MCP 服务器
        </span>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-meta text-tertiary"
          data-testid="session-mcp-summary"
          title={loading ? '正在读这条会话的 MCP 清单' : requestFailed ? '读不到这条会话的 MCP 清单' : summary}
        >
          {summary}
        </span>
      </summary>
      <div className="mt-1 min-w-0">
        <p className="text-meta leading-[1.55] text-tertiary">
          只影响这条会话启动时下发的服务器；改完要等下次重新托管才生效。
        </p>

        {/* 一行说明清单为什么是空的：机器上的原因（没资产 / 没版本 / 还没落到机器上）由 GET 给。 */}
        {emptyReason !== null ? (
          <p className="mt-1 text-meta leading-[1.55] text-tertiary" data-testid="session-mcp-note">
            {emptyReason}
          </p>
        ) : null}
        {loading ? (
          <p className="mt-1 text-meta text-tertiary" data-testid="session-mcp-loading">
            正在读清单…
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
                locked={saving !== null}
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
                  className="flex min-w-0 items-center gap-2 rounded-sm border border-dashed border-hair px-2 py-1.5 opacity-70"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-meta text-secondary" title={name}>
                    {name}
                  </span>
                  <span className="shrink-0 text-meta text-tertiary">不加载</span>
                  <Switch
                    name={name}
                    checked={false}
                    busy={saving === name}
                    locked={saving !== null}
                    onToggle={(on) => void toggle(name, on)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {requestFailed ? (
          <p className="mt-1.5 text-meta text-tertiary">读不到这条会话的 MCP 清单，过一会儿再打开详情看看。</p>
        ) : null}
        {error !== null ? (
          <p
            role="alert"
            data-testid="session-mcp-error"
            className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta text-rust"
          >
            <span className="min-w-0">{error}</span>
            {failed !== null ? (
              <button
                type="button"
                data-testid="session-mcp-retry"
                className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-primary"
                onClick={() => void toggle(failed.name, failed.on)}
                disabled={saving !== null}
              >
                再试一次
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** 抽屉/停靠面板共用这棵树：宽屏默认摊开，手机上默认收成一行摘要。 */
function desktopExpanded(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

function ServerRow({
  server,
  off,
  busy,
  locked,
  onToggle
}: {
  readonly server: SessionMcpServerDto;
  readonly off: boolean;
  readonly busy: boolean;
  readonly locked: boolean;
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
          <span className="mt-0.5 block truncate text-meta text-tertiary" title={`来自 ${server.assetName}`}>
            来自 {server.assetName} · {off ? '这次不加载' : '启动时下发'}
          </span>
        </span>
        <Switch name={server.name} checked={!off} busy={busy} locked={locked} onToggle={onToggle} />
      </div>
    </li>
  );
}

function Switch({
  name,
  checked,
  busy,
  locked,
  onToggle
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly locked: boolean;
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
      disabled={busy || locked}
      onChange={(event) => onToggle(event.target.checked)}
      className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-ring)] disabled:cursor-default disabled:opacity-40"
    />
  );
}
