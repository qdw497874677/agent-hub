import { createHash } from 'node:crypto';
import type { ServerToWorker, SessionEventDto } from '@agent-hub/contract';
import { RpcFailure, assetsFetch, assetsSync, providerTest } from '@agent-hub/contract';
import { asSessionId, asTaskId, withExecutableArg } from '@agent-hub/domain';
import type { RuntimeSession, SessionEvent, StartSpec } from '@agent-hub/domain';
import { authHeaders } from '../provider-proxy.ts';
import { createMcpEndpoint, type McpEndpoint } from '../mcp-endpoint.ts';
import { closeTerminals } from './channels.ts';
import { message, upstreamUrl, type LinkCtx, type SessionCommand } from './ctx.ts';
import type { Transport } from './transport.ts';

/**
 * 可选能力：ACP 适配器的会话能再 `session/load` 重放一遍历史。
 * node-gateway 不 import 具体 adapter，按结构判断，没有就当作不支持（其他 runtime 不受影响）。
 */
interface ResyncEntryLike {
  readonly key: string;
  readonly event: SessionEvent;
}
interface ResyncCapable {
  resync?(): Promise<readonly ResyncEntryLike[]>;
  /** 还没结束的后台子代理数量；0 就不用再拉。 */
  pendingSubagents?(): number;
}

export interface Sessions {
  /** 本机 MCP 入口（relay / 资产都经它进 hub）。 */
  readonly mcpEndpoint: McpEndpoint;
  /** 一条会话指令：`start_session` 与它的后续帧按会话串行。 */
  run(command: SessionCommand): Promise<void>;
  /** 清掉这条会话的活动记录与计时器（进程已经交出去 / 已经收掉）。 */
  forget(sessionId: string): void;
  /** 链路关闭：停计时器与补洞循环，dispose 所有会话，清空视图。 */
  closeAll(): Promise<void>;
}

export function installSessions(ctx: LinkCtx, transport: Transport): Sessions {
  const options = ctx.options;
  const channel = transport.channel;
  const send = transport.send;
  const { sessions, workspaces, sessionAgents, sessionProviders, lastActivity, idleTimers, prompting, pinnedSessions, starting, seenDeliveries } = ctx;
  /** 保活参数（ADR：回合结束 ≠ 进程结束）。 */
  const SESSION_IDLE_MS = options.sessionIdleMs ?? 900_000;
  const KEEPALIVE_MAX = options.keepAliveMax ?? 8;
  const PIN_MAX = options.pinMax ?? 16;
  /**
   * 每条活进程启动时的「工具授权 / MCP 接线」指纹（sha256 摘要，只比相等，不落原始令牌）。
   * hub 重新托管同一会话时可能换了 bearer 或 MCP 清单：接线不同就必须重建进程，
   * 否则 ACP 会留着启动时的旧 URL / 旧令牌继续跑。
   */
  const startupWiring = new Map<string, string>();

  channel.handle(assetsSync, async ({ entries, retain, sessions: liveSessions }) => {
    if (!options.assets) throw new RpcFailure('unsupported', '这台 Worker 不支持资产同步');
    const fetchBlobs = async (hashes: readonly string[]) => {
      const got = await channel.request(assetsFetch, { hashes: [...hashes] }, { timeoutMs: 120_000 });
      if (!got.ok) throw new Error(`取资产内容失败：${got.error.message}`);
      return got.value.blobs;
    };
    try {
      // sessions（协议 v7）：hub 报上来还活着的会话；一并重建视图、清掉孤儿视图（#226 P4）。
      // 旧 hub 不发 = 不动视图，会话启动时仍会自己按 start_session 的清单建/刷。
      const report = await options.assets.sync(entries, fetchBlobs, retain, liveSessions);
      const viewCount = Object.keys(report.views).length;
      options.onLog?.(
        `资产已同步：${entries.length} 项 → ${report.root}${viewCount > 0 ? `（${viewCount} 个会话视图）` : ''}`
      );
      return report;
    } catch (error) {
      throw new RpcFailure('failed', error instanceof Error ? error.message : String(error));
    }
  });
  /** agent 连的本机 MCP 入口：薄适配器，只把 JSON-RPC 经通道交给 hub。 */
  const mcpEndpoint = createMcpEndpoint(channel);
  channel.handle(providerTest, async ({ protocol, baseUrl, apiKey }) => {
    const target = upstreamUrl(ctx, baseUrl).replace(/\/+$/, '') + '/models';
    // 失败片段不回传密钥：照 hub 侧 probeModelsDirect 的方式先把密钥替换掉再截断。
    const scrub = (text: string): string => (apiKey ? text.split(apiKey).join('***') : text).replace(/\s+/g, ' ').slice(0, 200);
    try {
      const response = await fetch(target, { headers: { ...authHeaders(protocol, apiKey), accept: 'application/json', ...(protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) }, signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      let models: string[] = [];
      try {
        const body = JSON.parse(text) as { data?: { id?: unknown }[] };
        models = (body.data ?? []).flatMap((item) => (typeof item.id === 'string' ? [item.id] : [])).slice(0, 500);
      } catch {
        // 不是 JSON：只报状态
      }
      const message = response.ok ? `通了：${models.length} 个模型` : `HTTP ${response.status}${text ? '：' + scrub(text) : ''}`;
      return { ok: response.ok, status: response.status, message, models };
    } catch (failure) {
      const reason = failure instanceof Error ? (failure.name === 'TimeoutError' ? '超时' : failure.message) : String(failure);
      return { ok: false, status: 0, message: `连不上：${scrub(reason)}`, models: [] };
    }
  });

  /**
   * 后台子代理的补洞循环。
   *
   * opencode 在后台子代理还在跑时也会给 `session/prompt` 回 end_turn，之后它的 ACP 适配器
   * 不再推任何 `session/update`；子代理完成时注入的总结只有再 `session/load`（重放历史）
   * 才看得到。ACP 没有 history 接口，所以只能周期性重放——每轮把重放里**新**的事件按
   * 稳定指纹去重后照常发给 hub（hub 那边 ingest 会落盘 + 发帧）。
   */
  const RESYNC_INTERVAL_MS = options.resyncIntervalMs ?? 5_000;
  /**
   * 空闲轮次指数退避的上限。以前是「连续 12 轮没新东西就彻底停」，但 opencode 的重放里
   * 不一定带子代理终态：子代理其实还在跑，停拉之后它的总结就永远收不到。现在只要
   * `pendingSubagents() > 0` 就继续，只是把间隔翻倍到封顶，既不放弃也不空转。
   */
  const RESYNC_MAX_INTERVAL_MS = Math.max(RESYNC_INTERVAL_MS, options.resyncMaxIntervalMs ?? 60_000);
  const resyncLoops = new Map<
    string,
    {
      cancelled: boolean;
      timer: NodeJS.Timeout | null;
      /** 在途的 resync：发新 prompt 前要等它落地，session/load 不能和 session/prompt 并发。 */
      inFlight: Promise<void> | null;
      /** 当前调度间隔（毫秒）；空闲轮次把它翻倍。 */
      interval: number;
      /** 已经发出去的重放事件指纹（重放会带整段历史）。 */
      readonly seen: Set<string>;
    }
  >();

  function pendingSubagents(session: RuntimeSession): number {
    try {
      return (session as RuntimeSession & ResyncCapable).pendingSubagents?.() ?? 0;
    } catch {
      return 0;
    }
  }

  function stopResync(sessionId: string): void {
    const loop = resyncLoops.get(sessionId);
    if (!loop) return;
    loop.cancelled = true;
    if (loop.timer) {
      clearTimeout(loop.timer);
      loop.timer = null;
    }
    resyncLoops.delete(sessionId);
  }

  /** 用户又说话了：先停拉取，并等在途的 session/load 结束，再发 prompt。 */
  async function pauseResync(sessionId: string): Promise<void> {
    const loop = resyncLoops.get(sessionId);
    stopResync(sessionId);
    if (loop?.inFlight) await loop.inFlight.catch(() => undefined);
  }

  function startResync(sessionId: string, session: RuntimeSession): void {
    if (resyncLoops.has(sessionId)) return;
    const probe = session as RuntimeSession & ResyncCapable;
    if (typeof probe.resync !== 'function') return;
    const loop = {
      cancelled: false,
      timer: null as NodeJS.Timeout | null,
      inFlight: null as Promise<void> | null,
      interval: RESYNC_INTERVAL_MS,
      seen: new Set<string>()
    };
    resyncLoops.set(sessionId, loop);

    const schedule = (): void => {
      loop.timer = setTimeout(() => {
        loop.timer = null;
        void tick();
      }, loop.interval);
      loop.timer.unref?.();
    };

    /** 后台子代理都收尾了：停轮询（日志留着，方便对着 `还在等 N 个子代理` 看它是什么时候停的）。 */
    const finish = (): void => {
      options.onLog?.(`会话 ${sessionId} 子代理都结束了，停止重放`);
      stopResync(sessionId);
    };

    const tick = async (): Promise<void> => {
      // 会话被回收 / 被同 id 的新 start 顶替：立刻停，别调已 dispose 的进程。
      if (loop.cancelled || sessions.get(sessionId) !== session) {
        stopResync(sessionId);
        return;
      }
      if (pendingSubagents(session) === 0) {
        finish();
        return;
      }
      const run = (async () => {
        const entries = await probe.resync!();
        if (loop.cancelled || sessions.get(sessionId) !== session) return;
        const fresh = entries.filter((entry) => !loop.seen.has(entry.key));
        for (const entry of fresh) loop.seen.add(entry.key);
        if (fresh.length === 0) {
          // 重放里没新东西：子代理还在跑（pendingSubagents 还没归零），但别每 5 秒
          // `session/load` 一次——间隔翻倍到 60 秒封顶，一直等它报终态。
          loop.interval = Math.min(loop.interval * 2, RESYNC_MAX_INTERVAL_MS);
          const waiting = pendingSubagents(session);
          options.onLog?.(
            `会话 ${sessionId} 还在等 ${waiting} 个子代理，间隔 ${(loop.interval / 1000).toFixed(1)}s 后重放`
          );
          return;
        }
        loop.interval = RESYNC_INTERVAL_MS;
        options.onLog?.(`会话 ${sessionId} 补拉到 ${fresh.length} 条后台子代理输出`);
        for (const entry of fresh) {
          const enriched = await withBytes(sessionId, entry.event);
          send({ type: 'event', sessionId, event: enriched as SessionEventDto });
        }
      })();
      loop.inFlight = run;
      try {
        await run;
      } catch (error) {
        // session/load 也可能因为 agent 正忙而失败：记一行，下一轮再试。
        // 已经被取消（会话回收 / 用户发新 prompt）就不要报噪声了。
        if (!loop.cancelled) options.onLog?.(`会话 ${sessionId} 拉取后台子代理输出失败：${message(error)}`);
      } finally {
        if (loop.inFlight === run) loop.inFlight = null;
      }
      if (loop.cancelled || sessions.get(sessionId) !== session) return;
      if (pendingSubagents(session) === 0) {
        finish();
        return;
      }
      schedule();
    };

    schedule();
  }

  /** 上传的附件由 hub 随 prompt 发来（base64），在 agent 读它之前落进这台机器的项目目录。 */
  async function persistParts(parts: Extract<ServerToWorker, { kind: 'prompt' }>['parts']): Promise<void> {
    for (const part of parts) {
      if (part.kind === 'mention') continue;
      if (!part.path.includes('/.agent-hub/attachments/')) throw new Error(`附件路径不对：${part.path}`);
      if (!options.files) throw new Error('这台 Worker 不支持接收附件');
      await options.files.writeFile(part.path, new Uint8Array(Buffer.from(part.data, 'base64')));
    }
  }

  /**
   * 保活（回合结束 ≠ 进程结束）：每个事件 / 每句 prompt 都算一次活动，重置空闲计时。
   * 到点由 `retire` 收掉进程并报 `status:'ended'`。
   */
  function touch(sessionId: string): void {
    lastActivity.set(sessionId, Date.now());
    const existing = idleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    idleTimers.delete(sessionId);
    // 正在跑一轮：这期间不算空闲（prompt 收尾时会重新起算）
    if (prompting.has(sessionId)) return;
    // 常驻：用户明确要它一直留着，不按空闲收（仍会随 Worker 重启/退出消失）。
    if (pinnedSessions.has(sessionId)) return;
    if (!(SESSION_IDLE_MS > 0) || !sessions.has(sessionId)) return;
    const timer = setTimeout(() => void retire(sessionId, `${Math.round(SESSION_IDLE_MS / 1000)} 秒没有活动`), SESSION_IDLE_MS);
    timer.unref?.();
    idleTimers.set(sessionId, timer);
  }

  /** 清掉这条会话的活动记录与计时器（进程已经交出去 / 已经收掉）。 */
  function forget(sessionId: string): void {
    const timer = idleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    idleTimers.delete(sessionId);
    lastActivity.delete(sessionId);
    pinnedSessions.delete(sessionId);
    sessionAgents.delete(sessionId);
    sessionProviders.delete(sessionId);
    startupWiring.delete(sessionId);
    // 会话没了就别再 session/load 了（也顺带避免调已 dispose 的进程）。
    stopResync(sessionId);
  }

  /**
   * 真正收掉一条会话的进程：先把它从 `sessions` 里摘掉，事件循环的 finally 看到「已经不是它」
   * 就不会再报一遍 ended；然后关终端 / 关 provider 中转 / 报 `status:'ended'` / dispose。
   */
  async function retire(sessionId: string, reason: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    workspaces.delete(sessionId);
    forget(sessionId);
    await closeTerminals(ctx, sessionId);
    send({ type: 'status', sessionId, status: 'ended', reason });
    ctx.providerRelay.close(sessionId);
    options.onLog?.(`会话 ${sessionId} 回收：${reason}`);
    await session.dispose().catch(() => undefined);
  }

  /** 保活上限：超过 `KEEPALIVE_MAX` 时按最久没活动先收（`protect` = 刚起来的这条）。 */
  async function trimKeepAlive(protect: string): Promise<void> {
    if (!(KEEPALIVE_MAX > 0)) return;
    while (sessions.size > KEEPALIVE_MAX) {
      const victim = [...sessions.keys()]
        .filter((id) => id !== protect && !pinnedSessions.has(id))
        .sort((left, right) => (lastActivity.get(left) ?? 0) - (lastActivity.get(right) ?? 0))[0];
      if (!victim) return;
      await retire(victim, `超过保活上限（${KEEPALIVE_MAX} 个进程）`);
    }
  }

  /**
   * pinned 会话单独限流：保活上限只按 `sessions` 算，pinned 又不参与 trim，
   * 不设上限的话常驻会话可以无限堆。超过 `PIN_MAX` 的新 pinned 启动直接拒掉。
   */
  function pinnedAtCapacity(sessionId: string): boolean {
    if (!(PIN_MAX > 0)) return false;
    if (pinnedSessions.has(sessionId)) return false;
    return pinnedSessions.size >= PIN_MAX;
  }

  /** 产出物大小只有这台机器量得到：相对路径按会话的工作目录解析。 */
  async function withBytes(sessionId: string, event: SessionEvent): Promise<SessionEvent> {
    if (event.kind !== 'artifact' || !options.files) return event;
    const root = workspaces.get(sessionId);
    const absolute = event.path.startsWith('/') ? event.path : root ? `${root.replace(/\/+$/, '')}/${event.path}` : null;
    if (absolute === null) return event;
    const bytes = await options.files.stat(absolute);
    return bytes === null ? event : { ...event, bytes };
  }

  /** relay：URL 填成本机 MCP 入口，令牌不变。 */
  async function toolAccess(tools: NonNullable<StartSpec['tools']>): Promise<NonNullable<StartSpec['tools']>> {
    return { ...tools, url: await mcpEndpoint.url() };
  }

  /** MCP 资产：http 的那些指向本机中转入口的 `/mcp/<名字>`（hub 代连远端）；stdio 原样交给运行时拉起。目录能力若声明了 mcp 绑定且已选定可执行文件，启动时注入对应参数。 */
  async function mcpAccess(entries: NonNullable<Extract<ServerToWorker, { kind: 'start_session' }>['mcp']>): Promise<NonNullable<StartSpec['mcp']>> {
    const base = await mcpEndpoint.url();
    const inventory = options.inventory?.() ?? null;
    const capabilities = inventory?.capabilities ?? [];
    const acquisitions = inventory?.acquisitions ?? [];
    return entries.map((entry) => {
      if (entry.transport === 'http') return { transport: 'http', name: entry.name, url: `${base}/${encodeURIComponent(entry.name)}` };
      const cap = capabilities.find((item) => item.mcp?.name === entry.name);
      if (!cap?.mcp) return entry;
      const hit = acquisitions.find((item) => item.path && (item.capability === cap.capability || item.componentId === cap.via || !item.capability));
      if (!hit?.path) return entry;
      return { ...entry, args: withExecutableArg(entry.args, cap.mcp.executableArg, hit.path) };
    });
  }

  /**
   * 这次启动真正交给运行时的凭据 / MCP 接线的指纹。只拿它做相等判断：
   * 存的是 sha256，原始 bearer / env 密钥不进 map、不进日志。
   * provider 仍由 `sessionProviders` 单独比（行为不变）；这里管 tools 与 mcp，含「这次没有」。
   */
  function startupWiringKey(spec: StartSpec): string {
    const wiring = {
      tools: spec.tools ? { transport: spec.tools.transport, url: spec.tools.url, token: spec.tools.token } : null,
      mcp: (spec.mcp ?? []).map((entry) =>
        entry.transport === 'http'
          ? { transport: entry.transport, name: entry.name, url: entry.url }
          : { transport: entry.transport, name: entry.name, command: entry.command, args: entry.args, env: entry.env }
      )
    };
    return createHash('sha256').update(JSON.stringify(wiring)).digest('hex');
  }

  async function startSession(command: Extract<ServerToWorker, { kind: 'start_session' }>): Promise<void> {
    const runtime = options.runtimes.find((candidate) => candidate.descriptor.id === command.agentId);
    if (!runtime) {
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: `worker 未安装 ${command.agentId}` }
      });
      return;
    }

    const outside = options.files ? await options.files.check(command.workspaceRoot) : null;
    if (outside !== null) {
      send({ type: 'event', sessionId: command.sessionId, event: { kind: 'ended', outcome: 'failed', reason: outside } });
      return;
    }

    // 常驻会话每台机器有上限；到顶了新 pinned 启动直接拒，不 spawn、不进保活。
    if (command.pinned === true && pinnedAtCapacity(command.sessionId)) {
      const reason = `这台机器的常驻会话已达上限（${PIN_MAX}）`;
      send({ type: 'status', sessionId: command.sessionId, status: 'ended', reason });
      send({ type: 'event', sessionId: command.sessionId, event: { kind: 'diagnostic', level: 'warn', text: reason } });
      return;
    }

    let spec: StartSpec = {
      sessionId: asSessionId(command.sessionId),
      taskId: command.taskId === null ? null : asTaskId(command.taskId),
      workspaceRoot: command.workspaceRoot,
      resume: command.resume,
      options: command.options,
      ...(command.branch && command.resume === null ? { branch: command.branch } : {}),
      ...(command.tools ? { tools: await toolAccess(command.tools) } : {}),
      ...(command.tools && command.mcp && command.mcp.length > 0 ? { mcp: await mcpAccess(command.mcp) } : {})
    };
    if (command.provider) {
      const grant = command.provider;
      if (!runtime.descriptor.providers?.includes(grant.protocol)) {
        send({ type: 'event', sessionId: command.sessionId, event: { kind: 'ended', outcome: 'failed', reason: `${command.agentId} 不支持 ${grant.protocol} 协议的模型提供商` } });
        return;
      }
      // 真密钥（direct）或中转令牌（via hub）只留在这个进程的中继里；agent 拿到的是本机地址 + 会话令牌
      const relay = await ctx.providerRelay.open(command.sessionId, { baseUrl: upstreamUrl(ctx, grant.baseUrl), apiKey: grant.apiKey, protocol: grant.protocol, models: grant.models });
      spec = { ...spec, provider: { slug: grant.slug, name: grant.name, protocol: grant.protocol, models: grant.models, baseUrl: relay.baseUrl, token: relay.token } };
      options.onLog?.(`会话 ${command.sessionId} 用 hub 模型提供商「${grant.slug}」（${grant.via === 'hub' ? '经 hub 中转' : '本机直连'}）`);
    }
    const assets = await options.assets
      ?.current(new Set(command.assetIds ?? []), command.assetDigests)
      .catch((failure: Error) => {
        // 读不到本机资产清单 = 这次一个都不给（fail-closed），别把整条会话拖死。
        options.onLog?.(`读取本机资产清单失败，会话 ${command.sessionId} 这次不带资产：${failure.message}`);
        return undefined;
      });
    if (assets) spec = { ...spec, assets };
    if (command.assetIds && command.assetIds.length > 0) {
      const gone = await options.assets
        ?.missing(new Set(command.assetIds), command.assetDigests)
        .catch(() => [] as readonly string[]);
      if (gone && gone.length > 0) {
        send({
          type: 'event',
          sessionId: command.sessionId,
          event: { kind: 'diagnostic', level: 'warn', text: `这台机器上缺少 ${gone.length} 个资产：${gone.join('、')}；本次会话没有带上它们` }
        });
      }
    }

    // 同一会话又来一次 start（比如断线后 server 重新托管）：进程还活着、agent 和工作目录都没变，
    // 就直接复用——不能 spawn 第二个进程抢同一份会话文件。复用不了（分叉 / 换了 agent、目录
    // 或工具授权 / MCP 接线）才收掉旧的；被顶替的旧进程结束时不许给新会话报 ended（见事件循环的 finally）。
    const wiringKey = startupWiringKey(spec);
    const previous = sessions.get(command.sessionId);
    if (previous) {
      const providerKey = spec.provider ? `${spec.provider.slug}|${spec.provider.baseUrl}|${spec.provider.token}` : '';
      if (command.pinned === true) pinnedSessions.add(command.sessionId);
      else pinnedSessions.delete(command.sessionId);
      const wiringChanged = startupWiring.get(command.sessionId) !== wiringKey;
      const sameRuntime = sessionAgents.get(command.sessionId) === command.agentId
        && workspaces.get(command.sessionId) === command.workspaceRoot
        && sessionProviders.get(command.sessionId) === providerKey;
      const reusable = !spec.branch && sameRuntime && !wiringChanged;
      if (reusable) {
        // 复用也要把这次 start 带来的选项（模型等）落上去，别沿用进程里上一轮的
        for (const [optionId, value] of Object.entries(spec.options ?? {})) {
          const changed = await previous.changeOption(optionId, value).catch(() => null);
          if (changed && !changed.ok) options.onLog?.(`复用会话 ${command.sessionId} 时选项 ${optionId} 没落上：${changed.error.message}`);
          else if (changed) send({ type: 'options', sessionId: command.sessionId, options: [...changed.value] });
        }
        touch(command.sessionId);
        send({
          type: 'status',
          sessionId: command.sessionId,
          status: 'running'
        });
        return;
      }
      // hub 撤销旧 bearer 后会用新令牌 / 新清单再发一次 start：接线不同（含被移除）
      // 就必须换进程，否则 ACP 仍拿启动时的旧 URL 和旧令牌。
      if (sameRuntime && wiringChanged) {
        options.onLog?.(`会话 ${command.sessionId} 的工具授权 / MCP 接线变了，重建运行时`);
      }
      sessions.delete(command.sessionId);
      workspaces.delete(command.sessionId);
      forget(command.sessionId);
      await previous.dispose().catch(() => {});
    }

    // 每会话视图（#226 P4）：把这次要带的资产钉进 sessions/<sessionId>/，agent 只拿视图里的路径。
    // 别的会话换钉 / 卸载只改兼容链接和它们自己的视图，这条会话读到的那一版不受影响（D10：视图只在启动时建）。
    // 建不出来（本机清单还没同步到等）就退回 current() 的版本化路径，会话照常启动。
    if (assets && options.assets) {
      const view = await options.assets
        .view({ sessionId: command.sessionId, assetIds: command.assetIds ?? [], digests: command.assetDigests })
        .catch((failure: Error) => {
          options.onLog?.(`建会话视图失败，会话 ${command.sessionId} 改用版本化路径：${failure.message}`);
          return undefined;
        });
      if (view && view.assets.skills.length + view.assets.instructions.length > 0) spec = { ...spec, assets: view.assets };
    }

    let started = await runtime.start(spec);
    if (spec.branch) {
      // ADR 0028 Q5：原生分叉没成就退回「新开一条空会话」，告诉 hub 改用摘要交接——不能让用户卡在一条起不来的会话上
      let failure: string | null = null;
      if (!started.ok) {
        failure = started.error.message;
        options.onLog?.(`${command.agentId} 原生分叉失败，改为新开会话：${failure}`);
        const { branch: _dropped, ...plain } = spec;
        started = await runtime.start(plain);
      }
      if (ctx.nativeBranch && started.ok) {
        send({
          type: 'branch_result',
          sessionId: command.sessionId,
          outcome: failure === null ? 'native' : 'failed',
          ...(failure === null ? {} : { reason: failure.slice(0, 2000) })
        });
      }
    }
    if (!started.ok) {
      ctx.providerRelay.close(command.sessionId);
      options.onLog?.(`${command.agentId} 启动失败：${started.error.message}`);
      // 视图白建了：删掉，别留着一个没人用的会话目录（retain 仍按 hub 的清单管版本）。
      void options.assets?.dropSession(command.sessionId).catch(() => {});
      send({
        type: 'event',
        sessionId: command.sessionId,
        event: { kind: 'ended', outcome: 'failed', reason: started.error.message }
      });
      return;
    }

    const session = started.value;
    sessions.set(command.sessionId, session);
    workspaces.set(command.sessionId, command.workspaceRoot);
    sessionAgents.set(command.sessionId, command.agentId);
    if (command.pinned === true) pinnedSessions.add(command.sessionId);
    else pinnedSessions.delete(command.sessionId);
    sessionProviders.set(command.sessionId, spec.provider ? `${spec.provider.slug}|${spec.provider.baseUrl}|${spec.provider.token}` : '');
    startupWiring.set(command.sessionId, wiringKey);
    send({
      type: 'status',
      sessionId: command.sessionId,
      status: 'running'
    });
    // 保活上限：新进程起来后如果超了，先收最久没活动的那个（同样报 ended）。
    await trimKeepAlive(command.sessionId);
    // 空闲计时从现在起算；之后每个事件 / 每句 prompt 都刷新。
    touch(command.sessionId);

    void (async () => {
      try {
        for await (const event of session.events()) {
          if (sessions.get(command.sessionId) !== session) break;
          touch(command.sessionId);
          const enriched = await withBytes(command.sessionId, event);
          if (sessions.get(command.sessionId) !== session) break;
          send({ type: 'event', sessionId: command.sessionId, event: enriched as SessionEventDto });
          // ended 只是**这一轮**结束：进程留着（保活），下一句 prompt 直接发，只告诉 hub 它还活着。
          // 真结束（进程退出 / dispose_session / 空闲回收）才发 status:'ended'。
          if (event.kind === 'ended' && sessions.get(command.sessionId) === session) {
            send({ type: 'status', sessionId: command.sessionId, status: 'idle' });
            // 回合结束了但后台子代理还在跑：opencode 之后不再推任何 update，
            // 只能周期性重放历史把完成总结拉回来（收到全部 end / 回收时循环自己停）。
            if (pendingSubagents(session) > 0) startResync(command.sessionId, session);
          }
        }
      } finally {
        // 已被同 id 的新 start 顶掉 / 已被回收：新的那份才是这条会话，旧的不许再报 ended
        // （否则 server 会撤掉新会话的托管和刚签的工具令牌）；dispose 由顶替方做过了。
        if (sessions.get(command.sessionId) === session) {
          sessions.delete(command.sessionId);
          workspaces.delete(command.sessionId);
          forget(command.sessionId);
          await closeTerminals(ctx, command.sessionId);
          // 必须报「结束了」：不报的话 server 会一直以为这条会话还有人托管，
          // 下次提问就不再拉起 agent，只把 prompt 发给一个不存在的会话。
          send({ type: 'status', sessionId: command.sessionId, status: 'ended' });
          ctx.providerRelay.close(command.sessionId);
          await session.dispose();
          // 会话真结束了：删掉它的视图（版本目录仍由 retain / 其它视图引用决定去留）。
          await options.assets?.dropSession(command.sessionId).catch(() => false);
        }
      }
    })();
  }

  /**
   * 一条会话指令。`start_session` 先把自己接到同一会话的串行链尾，后续帧靠它等待
   * **最近提交**的那次 start；失败由 frames 的 `handle` 统一收尾，这里保持抛出。
   *
   * 同一会话的 start 必须串行：A 还在等运行时拉起进程时，B 不能并发跑完并把进程塞进
   * `sessions`——A 晚一步落地会把 B 顶掉（B 的进程泄漏，A 还会覆写 B 的状态）。串行后
   * B 一定看到 A 的会话，走「先 dispose 旧进程再拉起新进程」的替换路径。不同会话互不等待。
   */
  async function run(command: SessionCommand): Promise<void> {
    if (command.kind === 'start_session') {
      const sessionId = command.sessionId;
      const previous = starting.get(sessionId);
      const work = previous
        ? previous.catch(() => undefined).then(() => startSession(command))
        : startSession(command);
      // 先登记链尾再 await：之后到达的普通指令要等这（最近一次）start，而不是等前一条。
      const tail = work.catch(() => undefined);
      starting.set(sessionId, tail);
      try {
        await work;
      } finally {
        // A 的 finally 可能在 B 已经登记链尾之后才跑：只清自己那条，别删掉 B 的等待点。
        if (starting.get(sessionId) === tail) starting.delete(sessionId);
      }
      return;
    }

    const sessionId = command.sessionId;
    const pendingStart = starting.get(sessionId);
    if (pendingStart) await pendingStart;
    const session = sessions.get(sessionId);
    if (!session) {
      // server 以为这条会话还活着（它只在收到 ended 时才忘掉）。
      // 主动告诉它「已经不在了」，它下一次点击就会重新拉起，而不是又一次撞空。
      options.onLog?.(`未知会话：${sessionId}`);
      send({ type: 'status', sessionId, status: 'gone' });
      return;
    }
    if (command.kind === 'prompt') {
      // ADR 0031：hub 重试同一条消息时按 deliveryId 去重，agent 不会收到两遍
      if (command.deliveryId) {
        if (seenDeliveries.has(command.deliveryId)) {
          options.onLog?.(`重复的消息 ${command.deliveryId}，跳过`);
          return;
        }
        seenDeliveries.add(command.deliveryId);
        if (seenDeliveries.size > 1000) seenDeliveries.delete(seenDeliveries.values().next().value as string);
      }
      await persistParts(command.parts);
      // session/load 和 session/prompt 并发会让两边的 session/update 交错：先停补洞、等在途的重放落地。
      await pauseResync(sessionId);
      prompting.add(sessionId);
      touch(sessionId);
      try {
        const result = await session.prompt({
          text: command.text,
          parts: command.parts,
          ...(command.deliveryId ? { deliveryId: command.deliveryId } : {})
        });
        if (!result.ok) {
          send({
            type: 'event',
            sessionId,
            event: { kind: 'diagnostic', level: 'error', text: result.error.message }
          });
          // 通用错误不区分「没提交」和「提交后失联」；有投递 ID 时不能把它当停止证据。
          if (!command.deliveryId) {
            send({
              type: 'event',
              sessionId,
              event: { kind: 'ended', outcome: 'failed', reason: `发送失败：${result.error.message}` }
            });
          }
        }
      } finally {
        prompting.delete(sessionId);
        // 这一轮结束了：空闲从此刻起算（事件循环收到 ended 时也会再刷新一次）
        touch(sessionId);
      }
      return;
    }
    if (command.kind === 'interrupt') {
      await session.interrupt();
      return;
    }
    if (command.kind === 'compact') {
      const done = session.compact ? await session.compact(command.instructions) : null;
      if (done === null || !done.ok)
        send({
          type: 'event',
          sessionId,
          event: { kind: 'diagnostic', level: 'warn', text: done === null ? '这个运行时不支持手动压缩，可以重启会话' : `压缩失败：${done.error.message}` }
        });
      return;
    }
    if (command.kind === 'approval') {
      const done = session.respondApproval ? await session.respondApproval(command.approvalId, command.decision, command.author) : null;
      if (done === null || !done.ok)
        send({
          type: 'event',
          sessionId,
          event: { kind: 'diagnostic', level: 'warn', text: done === null ? '这个运行时不收批准回答' : `批准回答没送到：${done.error.message}` }
        });
      return;
    }
    if (command.kind === 'set_option') {
      const changed = await session.changeOption(command.optionId, command.value);
      if (!changed.ok) {
        send({
          type: 'event',
          sessionId,
          event: { kind: 'diagnostic', level: 'error', text: changed.error.message }
        });
        return;
      }
      send({ type: 'options', sessionId, options: [...changed.value] });
      return;
    }
    await session.dispose();
    sessions.delete(sessionId);
    workspaces.delete(sessionId);
    forget(sessionId);
    ctx.providerRelay.close(sessionId);
    await closeTerminals(ctx, sessionId);
  }

  return {
    mcpEndpoint,
    run,
    forget,
    async closeAll(): Promise<void> {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      for (const sessionId of [...resyncLoops.keys()]) stopResync(sessionId);
      for (const session of sessions.values()) await session.dispose();
      sessions.clear();
      workspaces.clear();
      sessionAgents.clear();
      sessionProviders.clear();
      startupWiring.clear();
      lastActivity.clear();
      prompting.clear();
    }
  };
}
