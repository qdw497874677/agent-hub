import type { PersistentAgentGrant } from '../../bot-grant.ts';
import type { PersistentAgent, BotId } from '../../bot.ts';
import type { WorkLogEntry } from '../../work-log.ts';
import type { WorkLogRepository } from '../../ports/work-log-repository.ts';
import type { SecretVault } from '../../ports/secret-vault.ts';
import { canonicalLink, type SessionLink } from '../../session-link.ts';
import type { SessionLinkRepository } from '../../ports/session-link-repository.ts';
import { isContainerSession } from '../../session.ts';
import type {
  AgentProfile,
  AgentProfileRepository,
  Artifact,
  ArtifactRepository,
  AssetSet,
  AssetSetRepository,
  CanvasLayout,
  JournalEntry,
  LayoutStore,
  PersistentAgentRepository,
  Project,
  ProjectRepository,
  ProjectWorkspaceLink,
  Session,
  SessionRepository,
  Task,
  TaskRepository,
  Workspace,
  WorkspaceFS,
  WorkspaceGroup,
  WorkspaceGroupId,
  WorkspaceGroupRepository,
  WorkspaceRepository
} from '../../index.ts';
import { ok } from '../../index.ts';

/** 各仓储的内存实现（projects / tasks / sessions / workspaces / …），语义与 SQLite 实现保持一致。 */

export function fakeProjects(): ProjectRepository {
  const rows = new Map<string, Project>();
  return {
    async save(project) {
      rows.set(project.id, project);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()].filter((p) => p.deletedAt === null);
    },
    async listDeleted() {
      return [...rows.values()].filter((p) => p.deletedAt !== null);
    },
    async remove(id) {
      rows.delete(id);
    }
  };
}

/** 密钥箱的替身：内存 Map（`put` 覆盖、`reveal` 只回存在的名字）。 */
export function fakeSecrets(): SecretVault & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async list() {
      return [...rows.entries()].map(([name, value]) => ({ name, updatedAt: value.length }));
    },
    async put(name, value) {
      rows.set(name, value);
    },
    async remove(name) {
      return rows.delete(name);
    },
    async reveal(names) {
      return Object.fromEntries(names.flatMap((name) => (rows.has(name) ? [[name, rows.get(name)!]] : [])));
    }
  };
}

export function fakeAssetSets(): AssetSetRepository & { rows: Map<string, AssetSet> } {
  const rows = new Map<string, AssetSet>();
  return {
    rows,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByTeam(teamId) {
      return [...rows.values()].filter((set) => set.teamId === teamId).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async save(set) {
      rows.set(set.id, set);
    },
    async remove(id) {
      rows.delete(id);
    }
  };
}

export function fakeWorkspaces(): WorkspaceRepository & { rows: Map<string, Workspace>; links: ProjectWorkspaceLink[] } {
  const rows = new Map<string, Workspace>();
  const links: ProjectWorkspaceLink[] = [];
  const all = () => [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    rows,
    links,
    async save(workspace) {
      const fresh = !rows.has(workspace.id);
      rows.set(workspace.id, workspace);
      if (fresh && workspace.kind === 'long_lived' && workspace.projectId !== null) {
        links.push({ projectId: workspace.projectId, workspaceId: workspace.id, linkedBy: null, linkedAt: workspace.createdAt });
      }
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async byProject(projectId) {
      const linked = new Set(links.filter((l) => l.projectId === projectId).map((l) => l.workspaceId as string));
      return all().filter((w) => (w.kind === 'temporary' ? w.projectId === projectId : linked.has(w.id)));
    },
    async longLived() {
      return all().filter((w) => w.kind === 'long_lived' && w.state !== 'removed');
    },
    async link(link) {
      if (!links.some((l) => l.projectId === link.projectId && l.workspaceId === link.workspaceId)) links.push(link);
    },
    async unlink(projectId, workspaceId) {
      const i = links.findIndex((l) => l.projectId === projectId && l.workspaceId === workspaceId);
      if (i >= 0) links.splice(i, 1);
    },
    async linksOf(workspaceId) {
      return links.filter((l) => l.workspaceId === workspaceId);
    },
    async byTask(taskId) {
      return all().filter((w) => w.ownerTaskId === taskId);
    },
    async temporaries() {
      return all().filter((w) => w.kind === 'temporary' && w.state !== 'removed');
    },
    async onMachine(workerId) {
      return all().filter((w) => w.workerId === workerId && w.state !== 'removed');
    }
  };
}

export function fakeTasks(shared: Map<string, Task> = new Map()): TaskRepository & { rows: Map<string, Task> } {
  const rows = shared;
  return { rows, ...taskOps(rows) };
}

export function taskOps(rows: Map<string, Task>): TaskRepository {
  return {
    async save(task) {
      rows.set(task.id, task);
    },
    async setBranch(id, branch) {
      if (branch === null) return false;
      const existing = rows.get(id);
      if (!existing) return false;
      rows.set(id, { ...existing, branch });
      return true;
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((task) => task.projectId === projectId);
    }
  };
}

export function fakeWorkLog(): WorkLogRepository & { rows: WorkLogEntry[] } {
  const rows: WorkLogEntry[] = [];
  return {
    rows,
    async append(draft) {
      const seq = rows.filter((row) => row.taskId === draft.taskId).reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      const entry: WorkLogEntry = { ...draft, seq, supersededBy: null };
      rows.push(entry);
      if (draft.supersedes) {
        const index = rows.findIndex((row) => row.id === draft.supersedes);
        if (index >= 0) rows[index] = { ...rows[index]!, supersededBy: entry.id };
      }
      return entry;
    },
    async byId(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async list(taskId, query) {
      return rows
        .filter((row) => row.taskId === taskId)
        .filter((row) => query.includeSuperseded || !row.supersededBy)
        .filter((row) => query.beforeSeq === undefined || row.seq < query.beforeSeq)
        .filter((row) => !query.excludeSystem || row.author.kind !== 'system')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, query.limit);
    },
    async latestNote(taskId) {
      return (await this.list(taskId, { limit: 1, excludeSystem: true }))[0] ?? null;
    }
  };
}

export function fakeSessions(tasks: Map<string, Task>): SessionRepository & { journal: Map<string, JournalEntry[]> } {
  const rows = new Map<string, Session>();
  const journal = new Map<string, JournalEntry[]>();
  return {
    journal,
    async save(session) {
      const existing = rows.get(session.id);
      // 常驻只经 setPinned 改：整行 save 不能把它冲掉（SQL 那边同样不写这一列）。
      const pinned = session.pinned ?? existing?.pinned;
      rows.set(
        session.id,
        existing
          ? { ...session, title: existing.title ?? null, ...(pinned === undefined ? {} : { pinned }) }
          : session
      );
    },
    async setPinned(id, pinned, at) {
      const existing = rows.get(id);
      if (!existing) return false;
      rows.set(id, pinned ? { ...existing, pinned: true, updatedAt: at } : { ...existing, pinned: undefined, updatedAt: at });
      return true;
    },
    async setTitle(id, title, at) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, title, updatedAt: at });
    },
    async setEnvironmentRevision(id, revision, at) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, environmentRevision: revision, updatedAt: at });
    },
    async markInterrupted(id, at) {
      const existing = rows.get(id);
      if (!existing || existing.status !== 'running') return false;
      rows.set(id, { ...existing, status: 'interrupted', updatedAt: at });
      return true;
    },
    async markRunning(id, at) {
      const existing = rows.get(id);
      if (!existing || existing.status !== 'interrupted') return false;
      rows.set(id, { ...existing, status: 'running', updatedAt: at });
      return true;
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByTask(taskId) {
      return [...rows.values()].filter((session) => session.taskId === taskId);
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((session) => !isContainerSession(session) && tasks.get(session.taskId as string)?.projectId === projectId);
    },
    async listByWorkspace(workspaceId) {
      return [...rows.values()].filter((session) => session.workspaceId === workspaceId);
    },
    async listAll() {
      return [...rows.values()];
    },
    async append(session, event, at) {
      const existing = rows.get(session.id);
      rows.set(session.id, existing ? { ...session, title: existing.title ?? null } : session);
      const entries = journal.get(session.id) ?? [];
      entries.push({ seq: session.lastSeq, event, at, turn: session.turn });
      journal.set(session.id, entries);
    },
    async eventsAfter(sessionId, afterSeq) {
      return (journal.get(sessionId) ?? []).filter((entry) => entry.seq > afterSeq);
    },
    async tail(sessionId, limit) {
      return (journal.get(sessionId) ?? []).slice(-limit);
    },
    async firstPrompt(sessionId) {
      return (journal.get(sessionId) ?? []).find((entry) => entry.event.kind === 'prompt') ?? null;
    },
    async linkEntry() {},
    async entryIdAt() {
      return null;
    },
    async remove(id) {
      rows.delete(id);
      journal.delete(id);
    }
  };
}

export function fakeArtifacts(): ArtifactRepository {
  const rows: Artifact[] = [];
  return {
    async save(artifact) {
      rows.push(artifact);
    },
    async bySession(sessionId) {
      return rows.filter((artifact) => artifact.sessionId === sessionId);
    },
    async byTask(taskId) {
      return rows.filter((artifact) => artifact.taskId === taskId);
    }
  };
}

export function fakeLayout(): LayoutStore {
  const rows = new Map<string, CanvasLayout>();
  return {
    async load(projectId) {
      return rows.get(projectId) ?? null;
    },
    async save(layout) {
      rows.set(layout.projectId, layout);
    }
  };
}

export function fakeSessionLinks(): SessionLinkRepository & { rows: Map<string, SessionLink> } {  const rows = new Map<string, SessionLink>();
  const key = (link: SessionLink): string => `${link.projectId}:${link.aSessionId}:${link.bSessionId}`;
  return {
    rows,
    async listByProject(projectId) {
      return [...rows.values()].filter((link) => link.projectId === projectId);
    },
    async forSession(sessionId) {
      return [...rows.values()].filter((link) => link.aSessionId === sessionId || link.bSessionId === sessionId);
    },
    async areLinked(one, other) {
      return [...rows.values()].some(
        (link) =>
          (link.aSessionId === one && link.bSessionId === other) ||
          (link.aSessionId === other && link.bSessionId === one)
      );
    },
    async save(link) {
      rows.set(key(link), link);
    },
    async remove(projectId, one, other) {
      rows.delete(key(canonicalLink(projectId, one, other, null, 0)));
    },
    async removeByProject(projectId) {
      for (const [id, link] of rows) if (link.projectId === projectId) rows.delete(id);
    }
  };
}

export function fakeAgentProfiles(): AgentProfileRepository & { rows: Map<string, AgentProfile> } {
  const rows = new Map<string, AgentProfile>();
  return {
    rows,
    async listByOwner(ownerId) {
      return [...rows.values()].filter((profile) => profile.ownerId === ownerId).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async save(profile) {
      rows.set(profile.id, profile);
    },
    async remove(id) {
      rows.delete(id);
    },
    async removeByOwner(ownerId) {
      for (const [id, profile] of rows) if (profile.ownerId === ownerId) rows.delete(id);
    }
  };
}

/** 组合工作空间仓储（只存归属；成员是 workspaces 表的行）。 */
export function fakeWorkspaceGroups(): WorkspaceGroupRepository & { rows: Map<WorkspaceGroupId, WorkspaceGroup> } {
  const rows = new Map<WorkspaceGroupId, WorkspaceGroup>();
  return {
    rows,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((group) => group.projectId === projectId).toSorted((a, b) => b.createdAt - a.createdAt);
    },
    async save(group) {
      rows.set(group.id, group);
    },
    async remove(id) {
      rows.delete(id);
    }
  };
}

/** 团队级 bot + 项目授权（C3a / bot-as-agent）。排序与 SQLite 实现一致：created_at，再按 name。 */export function fakeBots(): PersistentAgentRepository & { rows: Map<BotId, PersistentAgent>; grants: Map<string, PersistentAgentGrant> } {
  const rows = new Map<BotId, PersistentAgent>();
  const grants = new Map<string, PersistentAgentGrant>();
  const key = (botId: string, projectId: string) => `${botId}\u0000${projectId}`;
  const granted = (botId: string) => [...grants.values()].filter((grant) => grant.botId === botId);
  return {
    rows,
    grants,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async byName(teamId, name) {
      return [...rows.values()].find((bot) => bot.teamId === teamId && bot.name === name) ?? null;
    },
    async listByTeam(teamId) {
      return [...rows.values()]
        .filter((bot) => bot.teamId === teamId)
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    },
    async listForProject(projectId) {
      const ids = new Set([...grants.values()].filter((g) => g.projectId === projectId).map((g) => g.botId));
      return [...rows.values()]
        .filter((bot) => ids.has(bot.id))
        .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
    },
    async save(bot) {
      rows.set(bot.id, bot);
    },
    async remove(id) {
      rows.delete(id);
      for (const [k, grant] of grants) if (grant.botId === id) grants.delete(k);
    },
    async grantsOf(botId) {
      return granted(botId).sort((a, b) => a.createdAt - b.createdAt);
    },
    async grantsForProject(projectId) {
      return [...grants.values()].filter((grant) => grant.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
    },
    async grant(grant) {
      grants.set(key(grant.botId, grant.projectId), grant);
    },
    async revoke(botId, projectId) {
      grants.delete(key(botId, projectId));
    }
  };
}

export function fakeFs(): WorkspaceFS & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async directoryExists() {
      return true;
    },
    async listDirectories() {
      return [{ name: 'demo', path: '/tmp/demo' }];
    },
    async makeDirectory(parent, name) {
      return ok(`${parent.replace(/\/+$/, '')}/${name}`);
    },
    artifactDir(workspaceRoot, sessionId) {
      return `${workspaceRoot}/.agent-hub/artifacts/${sessionId}`;
    },
    async writeFile(path, content) {
      files.set(path, content);
      return ok(content.byteLength);
    },
    async stat() {
      return 128;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async listFiles(root, limit) {
      const all = [...files.keys()].filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1));
      return { files: all.slice(0, limit), truncated: all.length > limit };
    }
  };
}

export function fakeToolGrants(): import('../../ports/tool-grant-repository.ts').ToolGrantRepository & {
  grants: import('../../tool.ts').ToolGrant[];
  calls: import('../../tool.ts').ToolCallRecord[];
} {
  type Grant = import('../../tool.ts').ToolGrant;
  const grants: Grant[] = [];
  const calls: import('../../tool.ts').ToolCallRecord[] = [];
  return {
    grants,
    calls,
    async save(grant) {
      const at = grants.findIndex((row) => row.id === grant.id);
      if (at >= 0) grants[at] = grant;
      else grants.push(grant);
    },
    async byTokenHash(hash) {
      return grants.find((row) => row.tokenHash === hash) ?? null;
    },
    async activeForSession(sessionId, now) {
      return grants
        .filter((row) => row.sessionId === sessionId && row.revokedAt === null && row.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },
    async revokeAllExcept(keep, now) {
      let count = 0;
      grants.forEach((row, index) => {
        if (!keep.includes(row.sessionId) && row.revokedAt === null) {
          grants[index] = { ...row, revokedAt: now };
          count += 1;
        }
      });
      return count;
    },
    async revokeSession(sessionId, now) {
      let count = 0;
      grants.forEach((row, index) => {
        if (row.sessionId === sessionId && row.revokedAt === null) {
          grants[index] = { ...row, revokedAt: now };
          count += 1;
        }
      });
      return count;
    },
    async recordCall(record) {
      calls.push(record);
    },
    async recentCalls(limit, sessionId) {
      return calls.filter((row) => !sessionId || row.sessionId === sessionId).slice(-limit).reverse();
    }
  };
}
