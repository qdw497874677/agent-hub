import { createHash } from 'node:crypto';
import { asProjectId, locationOf, type Deps, type GroupStore, type JournalEntry, type MemoryScope, type MemorySource, type SourceDoc } from '@agent-hub/domain';

/**
 * 记忆来源（ADR 0019 §5 · P1）：就地索引，不复制、不搬家。
 * - adr：项目里 docs/adr/ 和 docs/decisions/ 下的 markdown；
 * - docs：其余 markdown（README、docs/**）；
 * - task：项目的任务（标题、目标、小结）。
 * 文件由项目所在的机器读（远端走 worker，Server 不读 worker 上的路径）。全部当不可信内容。
 */
const MAX_FILES = 400;
const MAX_MD = 200;
const MAX_BYTES = 128 * 1024;
const INDEX_CHARS = 40_000;

/** 同 domain 的 routeOf：本机 Worker 走 Server 自己的文件系统。 */
async function routeOf(deps: Pick<Deps, 'gateway'>, workerId: string | null): Promise<string | null> {
  if (workerId === null) return null;
  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === workerId);
  return worker?.origin === 'local' ? null : workerId;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const isAdr = (path: string) => /^docs\/(adr|decisions)\/.+\.md$/i.test(path);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(path) && !/(^|\/)CHANGELOG\.md$/i.test(path);
const titleOf = (path: string, text: string) => text.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 200) ?? path;

type FileDeps = Pick<Deps, 'projects' | 'workspaces' | 'gateway' | 'fs' | 'tasks'>;

async function projectRoot(deps: FileDeps, scope: MemoryScope) {
  if (scope.kind !== 'project') return null;
  const project = await deps.projects.byId(asProjectId(scope.projectId));
  if (!project || project.deletedAt !== null) return null;
  const location = await locationOf(deps, project, null);
  if (!location.root) return null;
  return { root: location.root.replace(/\/+$/, ''), route: await routeOf(deps, location.workerId) };
}

async function readText(deps: FileDeps, route: string | null, path: string): Promise<string | null> {
  if (route === null) {
    const bytes = await deps.fs.readFile(path);
    return bytes && bytes.byteLength <= MAX_BYTES ? new TextDecoder().decode(bytes) : null;
  }
  const read = await deps.gateway.readFile(route, path, MAX_BYTES);
  return read.ok && read.value ? new TextDecoder().decode(read.value) : null;
}

function markdownSource(deps: FileDeps, id: 'adr' | 'docs', match: (path: string) => boolean): MemorySource {
  const valid = (uri: string) => !uri.startsWith('/') && !uri.split('/').includes('..') && match(uri);
  return {
    id,
    scopeKinds: ['project'],
    async scan(scope) {
      const place = await projectRoot(deps, scope);
      if (!place) return { docs: [], partial: true };
      let listing: { files: readonly string[]; truncated: boolean };
      if (place.route === null) listing = await deps.fs.listFiles(place.root, MAX_FILES);
      else {
        const listed = await deps.gateway.listFiles(place.route, place.root, MAX_FILES);
        if (!listed.ok) return { docs: [], partial: true };
        listing = listed.value;
      }
      const files = listing.files.filter(valid).slice(0, MAX_MD);
      const docs: SourceDoc[] = [];
      let partial = listing.truncated;
      for (const uri of files) {
        const text = await readText(deps, place.route, `${place.root}/${uri}`);
        if (text === null) {
          partial = true;
          continue;
        }
        docs.push({ ref: { source: id, uri, hash: sha(text) }, title: titleOf(uri, text), text: text.slice(0, INDEX_CHARS), updatedAt: Date.now() });
      }
      return { docs, partial };
    },
    async read(scope, ref) {
      if (!valid(ref.uri)) return null;
      const place = await projectRoot(deps, scope);
      if (!place) return null;
      const text = await readText(deps, place.route, `${place.root}/${ref.uri}`);
      return text === null ? null : { text, hash: sha(text) };
    }
  };
}

function taskSource(deps: FileDeps): MemorySource {
  const render = (task: { title: string; goal: string | null; status: string; summary: string | null }) =>
    `# ${task.title}\n状态：${task.status}\n${task.goal ? `目标：${task.goal}\n` : ''}${task.summary ? `小结：${task.summary}\n` : ''}`;
  return {
    id: 'task',
    scopeKinds: ['project'],
    async scan(scope) {
      if (scope.kind !== 'project') return { docs: [], partial: true };
      const tasks = await deps.tasks.listByProject(asProjectId(scope.projectId));
      return {
        partial: false,
        docs: tasks.map((task) => {
          const text = render(task);
          return { ref: { source: 'task', uri: task.id, hash: sha(text) }, title: task.title, text, updatedAt: task.updatedAt };
        })
      };
    },
    async read(scope, ref) {
      if (scope.kind !== 'project') return null;
      const task = await deps.tasks.byId(ref.uri as never);
      if (!task || task.projectId !== scope.projectId) return null;
      const text = render(task);
      return { text, hash: sha(text) };
    }
  };
}

const TRANSCRIPT_EVENTS = 2000;
const TRANSCRIPT_SESSIONS = 100;

/** 会话记录只取人说的话和 agent 的回复文字（不含思考、工具原始输出、诊断）。 */
export function renderTranscript(events: readonly JournalEntry[]): string {
  const lines: string[] = [];
  let reply = '';
  const flush = () => {
    if (reply.trim() !== '') lines.push(`agent：${reply.trim()}`);
    reply = '';
  };
  for (const { event } of events) {
    if (event.kind === 'prompt') {
      flush();
      lines.push(`人：${event.text.trim()}`);
    } else if (event.kind === 'text') reply += event.delta;
    else if (event.kind === 'ended') flush();
  }
  flush();
  const text = lines.join('\n');
  // 太长留后面的（最近的更有用）
  return text.length > INDEX_CHARS ? text.slice(text.length - INDEX_CHARS) : text;
}

/** TranscriptSource（P2）：项目里各会话的人类消息和回复。uri = 会话 id。 */
function transcriptSource(deps: FileDeps & Pick<Deps, 'sessions'>): MemorySource {
  const load = async (sessionId: string) => renderTranscript(await deps.sessions.tail(sessionId as never, TRANSCRIPT_EVENTS));
  return {
    id: 'transcript',
    scopeKinds: ['project'],
    async scan(scope) {
      if (scope.kind !== 'project') return { docs: [], partial: true };
      const sessions = (await deps.sessions.listByProject(asProjectId(scope.projectId))).sort((a, b) => b.updatedAt - a.updatedAt);
      const docs: SourceDoc[] = [];
      for (const session of sessions.slice(0, TRANSCRIPT_SESSIONS)) {
        const text = await load(session.id);
        if (text === '') continue;
        const task = await deps.tasks.byId(session.taskId);
        docs.push({ ref: { source: 'transcript', uri: session.id, hash: sha(text) }, title: `会话记录 · ${task?.title ?? session.id}`, text, updatedAt: session.updatedAt });
      }
      return { docs, partial: sessions.length > TRANSCRIPT_SESSIONS };
    },
    async read(scope, ref) {
      if (scope.kind !== 'project') return null;
      const session = await deps.sessions.byId(ref.uri as never);
      if (!session) return null;
      const task = await deps.tasks.byId(session.taskId);
      if (!task || task.projectId !== scope.projectId) return null;
      const text = await load(session.id);
      return { text, hash: sha(text) };
    }
  };
}

/** GroupSource（P2）：项目里各群最近的消息。群属于项目，读权限跟项目走。uri = 群 id。 */
function groupSource(groups: Pick<GroupStore, 'group' | 'groupsOf' | 'posts'>): MemorySource {
  const load = async (groupId: string) => {
    const posts = await groups.posts(groupId, null, 500);
    const text = posts
      .map((post) => `${post.author.kind === 'user' ? post.author.name : post.author.kind === 'agent' ? post.author.role : '系统'}：${post.body}`)
      .join('\n');
    return text.length > INDEX_CHARS ? text.slice(text.length - INDEX_CHARS) : text;
  };
  return {
    id: 'group',
    scopeKinds: ['project'],
    async scan(scope) {
      if (scope.kind !== 'project') return { docs: [], partial: true };
      const docs: SourceDoc[] = [];
      for (const group of await groups.groupsOf(asProjectId(scope.projectId))) {
        const text = await load(group.id);
        if (text === '') continue;
        docs.push({ ref: { source: 'group', uri: group.id, hash: sha(text) }, title: `群 · ${group.name}`, text, updatedAt: group.updatedAt });
      }
      return { docs, partial: false };
    },
    async read(scope, ref) {
      if (scope.kind !== 'project') return null;
      const group = await groups.group(ref.uri);
      if (!group || group.projectId !== scope.projectId) return null;
      const text = await load(group.id);
      return { text, hash: sha(text) };
    }
  };
}

export function createMemorySources(deps: FileDeps & Pick<Deps, 'sessions'>, groups?: Pick<GroupStore, 'group' | 'groupsOf' | 'posts'>): MemorySource[] {
  return [
    markdownSource(deps, 'adr', (path) => isAdr(path)),
    markdownSource(deps, 'docs', (path) => isMarkdown(path) && !isAdr(path)),
    taskSource(deps),
    transcriptSource(deps),
    ...(groups ? [groupSource(groups)] : [])
  ];
}
