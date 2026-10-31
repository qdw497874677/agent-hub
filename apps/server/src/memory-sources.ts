import { createHash } from 'node:crypto';
import { asProjectId, locationOf, type Deps, type MemoryScope, type MemorySource, type SourceDoc } from '@agent-hub/domain';

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

export function createMemorySources(deps: FileDeps): MemorySource[] {
  return [markdownSource(deps, 'adr', (path) => isAdr(path)), markdownSource(deps, 'docs', (path) => isMarkdown(path) && !isAdr(path)), taskSource(deps)];
}
