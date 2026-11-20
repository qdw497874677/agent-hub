import * as assetModule from '../../asset.ts';
import type { WorkerStatus } from '../../index.ts';

/** 资产中心的内存实现（仓库、看板、可编程的投递与读取器）。 */

/** 资产中心的内存实现：仓库、同步看板、可编程的投递和读取器。 */
export function inMemoryAssets(now: () => number = () => 1_000) {
  const { assetScopeRef } = assetModule;
  type A = import('../../asset.ts').Asset;
  type R = import('../../asset.ts').AssetRevision;
  const assets = new Map<string, A>();
  const revisions = new Map<string, R[]>();
  const blobs = new Map<string, Uint8Array>();
  const installs: { workerId: string; assetId: string }[] = [];
  const projectSettings = new Map<string, Record<string, boolean>>();
  const sessionManifests = new Map<string, import('../../asset.ts').SessionAssetManifest>();
  const sessionSnapshots = new Map<string, import('../../asset.ts').SessionAssetSnapshot>();
  type FakeProject = { id: string; name: string; teamId: string | null; createdBy: string | null; members: readonly string[]; deletedAt: number | null };
  const projectList = new Map<string, FakeProject>([
    ['p1', { id: 'p1', name: 'demo', teamId: null, createdBy: null, members: [], deletedAt: null }]
  ]);
  const repo: import('../../ports/asset-repository.ts').AssetRepository = {
    list: async () => [...assets.values()],
    get: async (id) => assets.get(id) ?? null,
    byName: async (kind, name, projectId) =>
      [...assets.values()].find((a) => a.kind === kind && a.name === name && a.projectId === projectId && (a.scope === 'global' || a.scope === 'project')) ?? null,
    findInScope: async (kind, name, scope, ref) =>
      [...assets.values()].find((a) => a.kind === kind && a.name === name && a.scope === scope && assetScopeRef(a) === ref) ?? null,
    create: async (asset, revision, data) => {
      assets.set(asset.id, asset);
      revisions.set(asset.id, [revision]);
      for (const [k, v] of data) blobs.set(k, v);
    },
    addRevision: async (revision, data) => {
      const list = revisions.get(revision.assetId) ?? [];
      if (!list.some((r) => r.digest === revision.digest)) revisions.set(revision.assetId, [revision, ...list]);
      for (const [k, v] of data) blobs.set(k, v);
    },
    revisions: async (id) => revisions.get(id) ?? [],
    revision: async (id, digest) => (revisions.get(id) ?? []).find((r) => r.digest === digest) ?? null,
    update: async (asset) => void assets.set(asset.id, asset),
    remove: async (id) => {
      assets.delete(id);
      revisions.delete(id);
      for (let i = installs.length - 1; i >= 0; i--) if (installs[i]?.assetId === id) installs.splice(i, 1);
    },
    blob: async (sha) => blobs.get(sha) ?? null,
    installations: async () => [...installs],
    install: async (workerId, assetId) => {
      if (!installs.some((row) => row.workerId === workerId && row.assetId === assetId)) installs.push({ workerId, assetId });
    },
    uninstall: async (workerId, assetId) => {
      const at = installs.findIndex((row) => row.workerId === workerId && row.assetId === assetId);
      if (at >= 0) installs.splice(at, 1);
    },
    projectSettings: async (projectId) => ({ ...(projectSettings.get(projectId) ?? {}) }),
    setProjectSetting: async (projectId, assetId, enabled) => {
      const next = { ...(projectSettings.get(projectId) ?? {}) };
      if (enabled === null) delete next[assetId];
      else next[assetId] = enabled;
      projectSettings.set(projectId, next);
    },
    recordSessionAssets: async (manifest) => {
      sessionManifests.set(manifest.sessionId, manifest);
    },
    sessionAssets: async (sessionId) => sessionManifests.get(sessionId) ?? null,
    recordSessionAssetSnapshot: async (snapshot) => {
      if (sessionSnapshots.has(snapshot.sessionId)) return false;
      sessionSnapshots.set(snapshot.sessionId, snapshot);
      return true;
    },
    setSessionAssetSnapshot: async (snapshot) => {
      sessionSnapshots.set(snapshot.sessionId, snapshot);
    },
    sessionAssetSnapshot: async (sessionId) => sessionSnapshots.get(sessionId) ?? null,
    digestsForWorker: async (workerId) => [
      ...new Set(
        [...sessionManifests.values()]
          .filter((manifest) => manifest.workerId === workerId)
          .flatMap((manifest) => manifest.entries.map((entry) => entry.digest))
      )
    ],
    sessionAssetsForWorker: async (workerId) => {
      const out = new Map<string, import('../../asset.ts').SessionAssetDelivery>();
      for (const snapshot of sessionSnapshots.values()) {
        if (snapshot.workerId !== workerId) continue;
        out.set(snapshot.sessionId, {
          sessionId: snapshot.sessionId,
          assetIds: snapshot.entries.map((entry) => entry.assetId),
          digests: Object.fromEntries(snapshot.entries.map((entry) => [entry.assetId, entry.digest]))
        });
      }
      for (const manifest of sessionManifests.values()) {
        if (manifest.workerId !== workerId || out.has(manifest.sessionId)) continue;
        out.set(manifest.sessionId, {
          sessionId: manifest.sessionId,
          assetIds: manifest.entries.map((entry) => entry.assetId),
          digests: Object.fromEntries(manifest.entries.map((entry) => [entry.assetId, entry.digest]))
        });
      }
      return [...out.values()];
    }
  };
  const board = new Map<string, import('../../asset.ts').WorkerAssetSync>();
  const pushes: {
    workerId: string;
    manifest: readonly import('../../asset.ts').AssetManifestEntry[];
    retain?: readonly string[];
    sessions?: readonly import('../../asset.ts').SessionAssetDelivery[];
  }[] = [];
  const workers: WorkerStatus[] = [{ workerId: 'w1', label: 'local', origin: 'local', state: 'online' }];
  const git = {
    commit: 'c1',
    files: [] as import('../../asset.ts').IncomingFile[],
    calls: [] as { url: string; ref: string | null; path: string; kind: import('../../asset.ts').AssetKind; token: string | null }[]
  };
  const decode = (data: Uint8Array): string => new TextDecoder().decode(data);
  const secretStore = new Map<string, { value: string; at: number }>();
  const deps: import('../../use-cases/assets.ts').AssetDeps = {
    assets: repo,
    now,
    secrets: {
      list: async () => [...secretStore.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, { at }]) => ({ name, updatedAt: at })),
      put: async (name, value, at) => void secretStore.set(name, { value, at }),
      remove: async (name) => secretStore.delete(name),
      reveal: async (names) => Object.fromEntries(names.flatMap((name) => (secretStore.has(name) ? [[name, secretStore.get(name)!.value]] : [])))
    },
    board: { get: (id) => board.get(id) ?? null, set: (s) => void board.set(s.workerId, s), all: () => [...board.values()] },
    workers: { list: async () => workers },
    projects: {
      byId: async (id) => projectList.get(id) ?? null
    },
    delivery: {
      push: async (workerId, manifest, retain, sessions) => {
        pushes.push({ workerId, manifest, ...(retain === undefined ? {} : { retain }), ...(sessions === undefined ? {} : { sessions }) });
        return { ok: true, value: { root: '/home/x/.agent-hub/assets', installed: Object.fromEntries(manifest.map((m) => [m.assetId, m.digest])) } };
      }
    },
    reader: {
      // 极简 frontmatter：只认 `name:` / `description:` 两行。
      describe: (kind, files) => {
        const main = kind === 'skill' ? files.find((f) => f.path === 'SKILL.md') : files[0];
        const text = main ? decode(main.data) : '';
        const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
        return { ok: true, value: { name: kind === 'skill' ? field('name') : null, description: field('description') ?? '' } };
      },
      scanGit: async () => ({ ok: true, value: { commit: git.commit, candidates: [] } }),
      readGit: async (url, ref, path, kind, token) => {
        git.calls.push({ url, ref, path, kind, token: token ?? null });
        return { ok: true, value: { commit: git.commit, files: git.files } };
      },
      diffText: (path, before, after) => `--- ${path}\n-${before}\n+${after}`
    }
  };
  return { deps, board, pushes, workers, git, installs, blobs, projectList };
}
