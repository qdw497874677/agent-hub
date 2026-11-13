import { createHash } from 'node:crypto';
import type {
  AssetDeps,
  EnvironmentPlanner,
  McpLaunch,
  PreparedStart,
  Project,
  ProjectId,
  SessionAssetEntry,
  Task,
  TaskId,
  WorkerCommand
} from '@agent-hub/domain';
import { sessionAssetPlan, sessionMcpLaunch } from '@agent-hub/domain';

export type { PreparedStart };

type StartCommand = Extract<WorkerCommand, { kind: 'start_session' }>;

/**
 * 一次会话的环境版本。
 *
 * prepare 是「真的给 Worker 下发资产/MCP」的唯一入口；revision 复用同一套计算，
 * 只把结果压成 opaque hash。两者分开，避免 ensureHosted 去理解资产细节。
 */

export interface SessionEnvironmentOptions {
  readonly assetDeps: AssetDeps;
  readonly tasks: { byId(id: TaskId): Promise<Task | null> };
  readonly projects: { byId(id: ProjectId): Promise<Project | null> };
  readonly log?: (message: string) => void;
}

interface Resolved {
  readonly entries: readonly SessionAssetEntry[];
  readonly assetIds: readonly string[];
  readonly launch: readonly McpLaunch[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  readonly revision: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function envDigest(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return digest(JSON.stringify(entries.map(([key, value]) => [key, digest(value)])));
}

function stableRevision(
  projectId: string | null,
  workerId: string,
  entries: readonly SessionAssetEntry[],
  launch: readonly McpLaunch[],
  skipped: readonly { readonly name: string; readonly reason: string }[]
): string {
  const material = {
    projectId,
    workerId,
    assets: entries
      .map((entry) => [entry.assetId, entry.kind, entry.name, entry.digest, entry.scope])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    mcp: launch
      .map((item) =>
        item.transport === 'stdio'
          ? [
              item.name,
              'stdio',
              item.command,
              digest(JSON.stringify(item.args)),
              envDigest(item.env)
            ]
          : [item.name, 'http']
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    skipped: skipped
      .map((item) => [item.name, item.reason])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function createSessionEnvironment(options: SessionEnvironmentOptions): EnvironmentPlanner {
  const { assetDeps, tasks, projects, log } = options;

  async function resolve(
    workerId: string,
    taskId: TaskId,
    withMcp: boolean
  ): Promise<Resolved | null> {
    const task = await tasks.byId(taskId);
    if (!task) return null;
    const project = await projects.byId(task.projectId);
    const viewer = task.ownerId ? { userId: task.ownerId, teamId: project?.teamId ?? null } : null;
    const plan = await sessionAssetPlan(assetDeps, workerId, project?.id ?? null, viewer);
    let launch: readonly McpLaunch[] = [];
    let skipped: readonly { name: string; reason: string }[] = [];
    if (withMcp) {
      const launched = await sessionMcpLaunch(assetDeps, workerId, new Set(plan.assetIds));
      launch = launched.launch;
      skipped = launched.skipped;
    }
    return {
      entries: plan.entries,
      assetIds: plan.assetIds,
      launch,
      skipped,
      revision: stableRevision(project?.id ?? null, workerId, plan.entries, launch, skipped)
    };
  }

  return {
    async prepare(command) {
      if (command.kind !== 'start_session') return { command, revision: null };
      try {
        const resolved = await resolve(command.workerId, command.taskId, Boolean(command.tools));
        if (!resolved) return { command, revision: null };
        const launched = new Set(resolved.launch.map((item) => item.name));
        for (const item of resolved.skipped) {
          log?.(`MCP「${item.name}」这次没给会话 ${command.sessionId}：${item.reason}`);
        }
        const entries = resolved.entries.filter(
          (entry) => entry.kind !== 'mcp' || launched.has(entry.name)
        );
        const next: StartCommand = {
          ...command,
          assetIds: resolved.assetIds,
          ...(resolved.launch.length > 0 ? { mcp: resolved.launch } : {})
        };
        // 会话资产清单：实际给出去的那些（MCP 只算真的启动了的），会话界面展示用。
        await assetDeps.assets.recordSessionAssets({
          sessionId: command.sessionId,
          workerId: command.workerId,
          entries,
          at: Date.now()
        });
        return { command: next, revision: resolved.revision };
      } catch (failure) {
        log?.(`会话资产展开失败：${(failure as Error).message}`);
        return { command, revision: null };
      }
    },

    async revision(session) {
      if (!session.workerId) return null;
      try {
        const resolved = await resolve(session.workerId, session.taskId, true);
        return resolved?.revision ?? null;
      } catch (failure) {
        log?.(`会话环境版本计算失败：${(failure as Error).message}`);
        return null;
      }
    }
  };
}
