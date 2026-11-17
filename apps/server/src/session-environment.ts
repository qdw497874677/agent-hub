import { createHash } from 'node:crypto';
import type {
  AssetDeps,
  AssetSetRepository,
  EnvironmentPlanner,
  McpLaunch,
  PreparedStart,
  Project,
  ProjectId,
  Session,
  SessionAssetEntry,
  SessionAssetSnapshot,
  SessionAssetUpgrade,
  SessionEnvironmentRevisionInputs,
  Task,
  TaskId,
  WorkerCommand
} from '@agent-hub/domain';
import {
  ensureSessionAssetSnapshot,
  isContainerSession,
  resolveSessionAssets,
  sessionMcpLaunch,
  upgradeSessionAssets
} from '@agent-hub/domain';

export type { PreparedStart };

type StartCommand = Extract<WorkerCommand, { kind: 'start_session' }>;

/**
 * 一次会话的环境版本。
 *
 * prepare 是「真的给 Worker 下发资产/MCP」的唯一入口；revision 复用同一套输入，
 * 只把结果压成 opaque hash。两者分开，避免 ensureHosted 去理解资产细节。
 *
 * #225：revision 不再自己猜 `withMcp`（以前固定 true，命令没带 tools 时与 prepare 的
 * `Boolean(command.tools)` 永远对不上，于是每次投递都判 stale、每次都要解密 MCP 密钥）。
 * prepare 成功时把这次的输入写进 session_assets 清单（只含 digest，不含明文），
 * revision 从记录里读 MCP 部分、资产部分按当前状态重算——这样资产变了仍能触发重新托管，
 * 但不会再因为「工具这次没给」而永远 stale。
 */

export interface SessionEnvironmentOptions {
  readonly assetDeps: AssetDeps;
  /** 资产组合仓库：会话解析时按项目默认 / 显式选择展开。项目带组合时必须给。 */
  readonly assetSets?: Pick<AssetSetRepository, 'byId'>;
  readonly tasks: { byId(id: TaskId): Promise<Task | null> };
  readonly projects: { byId(id: ProjectId): Promise<Project | null> };
  /** 容器会话（无任务）的项目来源（#221 步骤 7）；返回 null 时按「解析失败」处理，不下发资产。 */
  readonly containerProject?: (sessionId: string) => Promise<{ projectId: ProjectId; ownerId: string | null } | null>;
  /**
   * 会话显式选的资产（#226 会话级选择）：返回 null = 按项目生效集。
   * 给了就只保留这些 id——想「这条会话不用某个技能」时，由调用方把完整清单减掉它。
   */
  readonly selectedAssetIds?: (sessionId: string) => Promise<readonly string[] | null>;
  /**
   * 这条会话的发起人（决定个人 / 团队资产给不给）。不给时回落到任务 owner。
   * 预览与下发必须用同一个人，否则勾选列表和实际清单会分叉。
   */
  readonly sessionOwner?: (sessionId: string) => Promise<string | null>;
  /**
   * 会话显式选的资产组合：返回 null / undefined = 按项目默认组合。
   * 组合里的资产会并进项目生效集（同名后者覆盖前者），再按机器已安装过滤。
   */
  readonly selectedAssetSetIds?: (sessionId: string) => Promise<readonly string[] | null | undefined>;
  /**
   * 允许清单 + 自动预热（#226）：把候选资产装到这台机器并同步，返回实际落地的 digest。
   * 返回 null = 装不上；此时会话启动会被拦住并说明原因，而不是静默少几个资产。
   */
  readonly preheat?: (workerId: string, assetIds: readonly string[]) => Promise<Readonly<Record<string, string>> | null>;
  readonly log?: (message: string) => void;
}

/** 解析出来的资产计划：项目 + 这台机器上生效且已经落地的资产。 */
interface Plan {
  readonly projectId: string | null;
  readonly entries: readonly SessionAssetEntry[];
  readonly assetIds: readonly string[];
  /** 真正展开的组合：有它快照来源才算 'set'。 */
  readonly setIds: readonly string[];
  /** 预热失败原因：有值时启动要被拦住。 */
  readonly blocked?: string;
}

type Skipped = readonly { readonly name: string; readonly reason: string }[];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function envDigest(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return digest(JSON.stringify(entries.map(([key, value]) => [key, digest(value)])));
}

function assetRows(entries: readonly SessionAssetEntry[]): string[][] {
  return entries
    .map((entry) => [entry.assetId, entry.kind, entry.name, entry.digest, entry.scope])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function mcpRows(launch: readonly McpLaunch[]): string[][] {
  return launch
    .map((item) =>
      item.transport === 'stdio'
        ? [item.name, 'stdio', item.command, digest(JSON.stringify(item.args)), envDigest(item.env)]
        : [item.name, 'http']
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function skippedRows(skipped: Skipped): string[][] {
  return skipped.map((item) => [item.name, item.reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function revisionInputs(
  projectId: string | null,
  workerId: string,
  entries: readonly SessionAssetEntry[],
  launch: readonly McpLaunch[],
  skipped: Skipped
): SessionEnvironmentRevisionInputs {
  return { projectId, workerId, assets: assetRows(entries), mcp: mcpRows(launch), skipped: skippedRows(skipped) };
}

/** 版本 = 输入快照的哈希。字段顺序固定成数组，读回来的对象键序不影响结果。 */
function revisionDigest(inputs: SessionEnvironmentRevisionInputs): string {
  return digest(JSON.stringify([inputs.projectId, inputs.workerId, inputs.assets, inputs.mcp, inputs.skipped]));
}

export function createSessionEnvironment(options: SessionEnvironmentOptions): EnvironmentPlanner {
  const { assetDeps, tasks, projects, log } = options;

  async function planFor(
    sessionId: string,
    workerId: string,
    taskId: TaskId | null,
    container?: { projectId: ProjectId | null; ownerId: string | null }
  ): Promise<Plan | null> {
    // 这里的 taskId 是 prepare 的参数而不是 Session 对象，保留 null 判据。
    const task = taskId === null ? null : await tasks.byId(taskId);
    if (taskId !== null && !task) return null;
    if (taskId === null && !container?.projectId) return null;
    const projectId = (task ? task.projectId : container?.projectId) ?? null;
    const ownerId = task ? task.ownerId : container?.ownerId ?? null;
    const project = projectId === null ? null : await projects.byId(projectId as ProjectId);
    // 发起人优先用会话自己的（预览也用它）；没有会话时回落到任务 owner。
    const sessionOwner = (await options.sessionOwner?.(sessionId)) ?? null;
    const viewerId = sessionOwner ?? ownerId;
    const viewer = viewerId ? { userId: viewerId, teamId: project?.teamId ?? null } : null;
    // 会话显式组合优先；否则用项目默认。取不到的 id 在解析里被忽略（组合可能刚被删）。
    const explicitSets = await options.selectedAssetSetIds?.(sessionId);
    const setIds = explicitSets ?? project?.assetSetIds ?? [];
    if (setIds.length > 0 && !options.assetSets) {
      log?.(`会话 ${sessionId} 要用资产组合，但组合仓库没有就绪`);
      return null;
    }
    const plan = await resolveSessionAssets({ assets: assetDeps.assets, board: assetDeps.board, ...(options.assetSets === undefined ? {} : { assetSets: options.assetSets }) }, {
      sessionId,
      workerId,
      projectId: project?.id ?? null,
      viewer,
      setIds,
      assetIds: (await options.selectedAssetIds?.(sessionId)) ?? null,
      ...(options.preheat === undefined ? {} : { ensure: options.preheat }),
      ...(log === undefined ? {} : { log })
    });
    if (plan.blocked !== undefined) {
      log?.(`会话 ${sessionId} 的资产没有准备好：${plan.blocked}`);
      return { projectId: project?.id ?? null, entries: [], assetIds: [], setIds: plan.setIds, blocked: plan.blocked };
    }
    return { projectId: project?.id ?? null, entries: plan.entries, assetIds: plan.assetIds, setIds: plan.setIds };
  }

  return {
    async prepare(command) {
      if (command.kind !== 'start_session') return { command, revision: null };
      try {
        // #226 P2：快照一旦写下就是权威清单；resume / 重新托管不再重新解析当前生效集。
        let snapshot: SessionAssetSnapshot | null = await assetDeps.assets.sessionAssetSnapshot(command.sessionId);
        // 首次启动先解析出生效集当候选；等资产真正展开成功后再落快照（被 blocked 的启动不算「开始第一轮」）。
        let candidate: SessionAssetSnapshot | null = null;
        if (!snapshot) {
          // command 是 StartCommand（不是 Session）：容器门禁仍以 taskId === null 为准。
          const container = command.taskId === null ? await options.containerProject?.(command.sessionId) ?? null : undefined;
          const plan = await planFor(command.sessionId, command.workerId, command.taskId, container ?? undefined);
          // #223：解析不到任务 / 项目 = 资产展开失败。不能再原样下发（那等于「全给」）。
          if (!plan) {
            log?.(`会话 ${command.sessionId} 的资产没有准备好：找不到所属的任务或项目`);
            // 连命令也带上显式空集：万一有调用方漏看 blocked，也不会退回 v3 的「缺省 = 全给」。
            return { command: { ...command, assetIds: [] }, revision: null, blocked: '会话资产没有准备好：找不到会话所属的任务或项目' };
          }
          if (plan.blocked !== undefined) {
            return { command: { ...command, assetIds: [] }, revision: null, blocked: `会话资产没有准备好：${plan.blocked}` };
          }
          candidate = {
            sessionId: command.sessionId,
            mode: 'snapshot',
            // 有组合参与就记 'set'：从快照能看出资产是「项目生效集」还是「组合」来的。
            source: plan.setIds.length > 0 ? 'set' : 'project',
            workerId: command.workerId,
            projectId: plan.projectId,
            entries: plan.entries,
            at: Date.now()
          };
          snapshot = candidate;
        }
        const withMcp = Boolean(command.tools);
        let launch: readonly McpLaunch[] = [];
        let skipped: Skipped = [];
        if (withMcp) {
          const launched = await sessionMcpLaunch(
            assetDeps,
            command.workerId,
            new Set(snapshot.entries.map((entry) => entry.assetId))
          );
          launch = launched.launch;
          skipped = launched.skipped;
        }
        // 展开成功才算真正开始：先写快速照（并发时先写者赢），之后一律按它。
        if (candidate) snapshot = await ensureSessionAssetSnapshot(assetDeps, candidate);
        const inputs = revisionInputs(snapshot.projectId, command.workerId, snapshot.entries, launch, skipped);
        const launchedNames = new Set(launch.map((item) => item.name));
        for (const item of skipped) {
          log?.(`MCP「${item.name}」这次没给会话 ${command.sessionId}：${item.reason}`);
        }
        const entries = snapshot.entries.filter((entry) => entry.kind !== 'mcp' || launchedNames.has(entry.name));
        const next: StartCommand = {
          ...command,
          // 总是显式给（可能是空数组）：缺省在 v4 语义里也是一个都不给，但显式写出来才能解释。
          assetIds: snapshot.entries.map((entry) => entry.assetId),
          // #226 E4c：连版本一起下发，Worker 按 digest 取不可变目录，不随机器上的当前版本漂移。
          assetDigests: Object.fromEntries(snapshot.entries.map((entry) => [entry.assetId, entry.digest])),
          ...(launch.length > 0 ? { mcp: launch } : {})
        };
        // 会话资产清单：实际给出去的那些（MCP 只算真的启动了的），会话界面展示用。
        // revision 字段是这次环境版本的输入快照（#225），revision() 只读它，不再解密密钥。
        await assetDeps.assets.recordSessionAssets({
          sessionId: command.sessionId,
          workerId: command.workerId,
          entries,
          at: Date.now(),
          revision: inputs
        });
        return { command: next, revision: revisionDigest(inputs) };
      } catch (failure) {
        const reason = (failure as Error).message;
        log?.(`会话资产展开失败：${reason}`);
        // #223：展开失败（解密、存储、网关异常）不下发会话，交给调用方标记 failed 并告知用户。
        return { command: { ...command, assetIds: [] }, revision: null, blocked: `会话资产没有准备好：${reason}` };
      }
    },

    async revision(session) {
      if (!session.workerId) return null;
      try {
        // 没记过输入（旧会话 / 还没下发过）：算不出来就维持旧行为，不猜也不解密。
        const recorded = await assetDeps.assets.sessionAssets(session.id);
        if (!recorded?.revision) return null;
        // #226 P2：只比快照内容。资产被换钉但本会话没升级时，版本保持不变、不会被重新托管。
        const snapshot = await assetDeps.assets.sessionAssetSnapshot(session.id);
        if (snapshot) {
          return revisionDigest({
            projectId: snapshot.projectId,
            workerId: session.workerId,
            assets: assetRows(snapshot.entries),
            // MCP 启动细节仍取自上次下发的记录：重新展开要解密密钥，那正是 #225 要避免的。
            mcp: recorded.revision.mcp,
            skipped: recorded.revision.skipped
          });
        }
        // 升级前启动的旧会话没有独立快照：用它启动时记录下来的环境输入，冻结在那一刻。
        return revisionDigest(recorded.revision);
      } catch (failure) {
        log?.(`会话环境版本计算失败：${(failure as Error).message}`);
        return null;
      }
    },

    async upgrade(session: Session): Promise<SessionAssetUpgrade | null> {
      if (!session.workerId) return null;
      try {
        const container = isContainerSession(session) ? await options.containerProject?.(session.id) ?? null : undefined;
        const plan = await planFor(session.id, session.workerId, session.taskId, container ?? undefined);
        if (!plan) return null;
        return await upgradeSessionAssets(assetDeps, {
          sessionId: session.id,
          workerId: session.workerId,
          projectId: plan.projectId,
          entries: plan.entries
        });
      } catch (failure) {
        log?.(`会话资产升级失败：${(failure as Error).message}`);
        return null;
      }
    }
  };
}
