import {
  RpcFailure,
  fsListDirectories,
  fsListFiles,
  fsMakeDirectory,
  fsReadFile,
  wsAddWorktree,
  wsInspectPlannedWorktree,
  wsCreatePlannedWorktree,
  wsVerifyPlannedWorktree,
  wsResolvePlannedBase,
  wsPreparePlannedBase,
  wsGroupInit,
  wsGroupRemove,
  wsNewWorktree,
  wsRunSetup,
  wsClone,
  wsInspect,
  wsCheckRepo,
  wsRemove,
  wsSaveWip,
  wsPreview,
  wsCommit,
  wsPush,
  wsPublishRef,
  wsPrepareDelegationWorktree,
  wsImportCommit,
  wsImportProjectGitBundle,
  wsGh,
  wsStatus,
  filesChanged,
  filesChanges,
  filesDiff,
  filesFind,
  filesHead,
  filesBranchBase,
  filesRestore,
  filesCheckpoint,
  filesDropRefs,
  filesList,
  filesRead,
  filesUnwatch,
  filesWatch,
  type RpcPort
} from '@agent-hub/contract';
import type { DomainError, Result } from '@agent-hub/domain';
import { createGitWorkspace, createGroupWorktrees, type GitWorkspaceOptions } from './git-workspace.ts';
import { createGroupDir } from './group-dir.ts';
import { createWorkspaceBrowser } from './workspace-browser.ts';
import type { WorkerFiles } from './worker-files.ts';
import type { ProjectGitBundleImporter } from './project-git-bundle-import.ts';

// Only an explicitly returned, settled mutation result gets this wire code.
// An unexpected throw remains the channel's generic `failed` (unknown outcome).
const unwrapSettled = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  if (result.error.operationSettled) throw new RpcFailure(`operation_settled_${result.error.code}`, result.error.message);
  throw new RpcFailure('failed', result.error.message);
};

/**
 * Worker 侧文件操作适配器：RPC 端口上的 fs.* 方法 → WorkerFiles（WORKER_ROOTS 边界在它里面）。
 * 不认识传输；没有 files 就一律答「这台不支持」。
 */
export function serveWorkerFiles(port: RpcPort, files: WorkerFiles | undefined, fallbackRoots: readonly string[] = [], gitOptions: GitWorkspaceOptions = {}): void {
  const need = (what: string): WorkerFiles => {
    if (!files) throw new RpcFailure('unsupported', `这台 Worker 不支持${what}`);
    return files;
  };
  port.handle(fsListDirectories, async ({ path }) => {
    const target = path === '' ? (files?.roots[0] ?? fallbackRoots[0] ?? '/') : path;
    return need('浏览目录').listDirectories(target);
  });
  port.handle(fsMakeDirectory, async ({ parent, name }) => {
    const fs = need('新建文件夹');
    try {
      return { path: await fs.makeDirectory(parent, name) };
    } catch (error) {
      throw new RpcFailure('invalid', error instanceof Error ? error.message : String(error));
    }
  });
  port.handle(fsListFiles, async ({ root, limit }) => need('列文件').listFiles(root, limit));
  port.handle(fsReadFile, async ({ path, maxBytes }) => {
    const bytes = await need('读文件').readFile(path, maxBytes);
    return { data: bytes === null ? null : Buffer.from(bytes).toString('base64') };
  });

  serveWorkspaceGit(port, files, gitOptions);
  serveWorkspaceGroups(port, files, gitOptions);
  serveWorkspaceBrowser(port, files);
}

/** ws.*：工作空间的 git / 目录操作，边界和 fs.* 一样是 WORKER_ROOTS（没有 files 就整组不支持）。 */
function serveWorkspaceGit(port: RpcPort, files: WorkerFiles | undefined, gitOptions: GitWorkspaceOptions): void {
  const git = files ? createGitWorkspace((path) => files.check(path), gitOptions) : null;
  const need = () => {
    if (!git) throw new RpcFailure('unsupported', '这台 Worker 不支持工作空间操作');
    return git;
  };
  const unwrap = <T>(result: Result<T, DomainError>): T => {
    if (result.ok) return result.value;
    throw new RpcFailure(result.error.code === 'invalid' || result.error.code === 'conflict' ? result.error.code : 'failed', result.error.message);
  };
  port.handle(wsInspect, async ({ path }) => unwrap(await need().inspect(path)));
  port.handle(wsInspectPlannedWorktree, async (input) => {
    const method = need().inspectPlannedWorktree;
    if (!method) throw new RpcFailure('unsupported', '不支持计划来源检查');
    return unwrap(await method(input));
  });
  port.handle(wsCreatePlannedWorktree, async (input) => {
    const method = need().createPlannedWorktree;
    if (!method) throw new RpcFailure('unsupported', '不支持计划检出');
    return unwrapSettled(await method(input));
  });
  port.handle(wsVerifyPlannedWorktree, async (input) => {
    const method = need().verifyPlannedWorktree;
    if (!method) throw new RpcFailure('unsupported', '不支持计划检出证明');
    return unwrap(await method(input));
  });
  port.handle(wsResolvePlannedBase, async (input) => {
    const method = need().resolvePlannedBase;
    if (!method) throw new RpcFailure('unsupported', '不支持计划底座探测');
    return unwrap(await method(input));
  });
  port.handle(wsPreparePlannedBase, async (input) => {
    const method = need().preparePlannedBase;
    if (!method) throw new RpcFailure('unsupported', '不支持计划底座准备');
    return unwrapSettled(await method(input));
  });
  port.handle(wsCheckRepo, async ({ repoUrl, branch, auth }) => unwrap(await need().checkRepo(repoUrl, branch ?? null, auth)));
  port.handle(wsClone, async (input) => unwrapSettled(await need().clone(input)));
  port.handle(wsAddWorktree, async (input) => unwrapSettled(await need().addWorktree(input)));
  port.handle(wsRunSetup, async (input) => unwrap(await need().runSetup(input)));
  port.handle(wsStatus, async ({ path }) => unwrap(await need().status(path)));
  port.handle(wsSaveWip, async ({ path, message, auth }) => unwrap(await need().saveWip(path, message, auth)));
  port.handle(wsPreview, async ({ path, maxPatchBytes, redactSensitive }) => {
    const preview = unwrap(await need().preview(path, maxPatchBytes, redactSensitive ? { redactSensitive: true } : undefined));
    return { ...preview, files: [...preview.files] };
  });
  port.handle(wsCommit, async ({ path, ...input }) => unwrap(await need().commit(path, input)));
  port.handle(wsPush, async ({ path, auth }) => unwrap(await need().push(path, auth)));
  port.handle(wsPublishRef, async (input) => {
    const git = need();
    if (!git.publishRef) throw new RpcFailure('unsupported', '这台 Worker 不支持发布批准提交（publish_ref）');
    return unwrap(await git.publishRef(input));
  });
  port.handle(wsPrepareDelegationWorktree, async (input) => {
    const git = need();
    if (!git.prepareDelegationWorktree) throw new RpcFailure('unsupported', '这台 Worker 不支持严格准备委派工作区（prepare_delegation_worktree）');
    return unwrap(await git.prepareDelegationWorktree(input));
  });
  port.handle(wsImportCommit, async (input) => {
    const git = need();
    if (!git.importCommit) throw new RpcFailure('unsupported', '这台 Worker 不支持本地导入提交（import_commit）');
    return unwrap(await git.importCommit(input));
  });
  port.handle(wsGh, async ({ path, request }) => {
    const outcome = unwrap(await need().gh(path, request));
    if (!outcome.ok) return { ok: false as const, reason: outcome.reason };
    // 传输层数组要可变（GhOutcome 里是 readonly）：拷一层
    return 'prs' in outcome ? { ok: true as const, prs: [...outcome.prs] } : outcome;
  });
  port.handle(wsRemove, async ({ path, kind, force, mergedHead }) => unwrapSettled(await need().remove(path, kind, { force: force === true, ...(mergedHead ? { mergedHead } : {}) })));
}

/**
 * ws.group_* / ws.new_worktree：组合工作空间（docs/design/multi-repo.md §12.1 / §12.5）。
 * 没配 WORKER_GROUPS_DIR 的 Worker 整组回 unsupported——老 Worker 上 hub 会退回单仓库路径。
 */
function serveWorkspaceGroups(port: RpcPort, files: WorkerFiles | undefined, gitOptions: GitWorkspaceOptions): void {
  const groupsDir = gitOptions.groupsDir;
  const dir = files && groupsDir ? createGroupDir({ groupsDir, check: (path) => files.check(path) }) : null;
  const trees = files && groupsDir ? createGroupWorktrees((path) => files.check(path), { groupsDir }) : null;
  const needDir = () => {
    if (!dir) throw new RpcFailure('unsupported', '这台 Worker 不支持组合工作空间（没有配置 WORKER_GROUPS_DIR）');
    return dir;
  };
  const needTrees = () => {
    if (!trees) throw new RpcFailure('unsupported', '这台 Worker 不支持组合工作空间（没有配置 WORKER_GROUPS_DIR）');
    return trees;
  };
  const unwrap = <T>(result: Result<T, DomainError>): T => {
    if (result.ok) return result.value;
    throw new RpcFailure(result.error.code === 'invalid' || result.error.code === 'conflict' ? result.error.code : 'failed', result.error.message);
  };
  port.handle(wsGroupInit, async ({ slug, name, id }) => unwrap(await needDir().init({ slug, name, id })));
  port.handle(wsGroupRemove, async ({ root, id }) => {
    const result = await needDir().remove({ root, id });
    return unwrapSettled(result.ok ? result : { ok: false, error: { ...result.error, operationSettled: true } });
  });
  port.handle(wsNewWorktree, async (input) => unwrapSettled(await needTrees().newWorktree(input)));
}

/**
 * files.*：工作空间文件浏览（ADR 0025）。根要在 WORKER_ROOTS 里，相对路径由 WorkspaceBrowser 用 realpath 关住。
 * 变化经 files.changed 报给 hub；hub 说不认识这个订阅（或连接断了）就自己停掉，免得重连后留下孤儿 watcher。
 */
function serveWorkspaceBrowser(port: RpcPort, files: WorkerFiles | undefined): void {
  const browser = files ? createWorkspaceBrowser({ guard: (root) => files.check(root) }) : null;
  const need = () => {
    if (!browser) throw new RpcFailure('unsupported', '这台 Worker 不支持浏览工作空间文件');
    return browser;
  };
  const unwrap = <T>(result: Result<T, DomainError>): T => {
    if (result.ok) return result.value;
    const code = result.error.code;
    throw new RpcFailure(code === 'invalid' || code === 'conflict' ? code : code === 'not_found' ? 'not_found' : 'failed', result.error.message);
  };
  const watches = new Map<string, () => void>();
  port.handle(filesList, async ({ root, path, limit }) => {
    const page = unwrap(await need().list(root, path, { limit }));
    return { ...page, entries: [...page.entries] };
  });
  port.handle(filesRead, async ({ root, path, maxBytes }) => {
    const { bytes, ...rest } = unwrap(await need().read(root, path, maxBytes));
    return { ...rest, data: Buffer.from(bytes).toString('base64') };
  });
  port.handle(filesFind, async ({ root, query, limit }) => ({ files: [...unwrap(await need().find(root, query, limit))] }));
  port.handle(filesChanges, async ({ root, base, target }) => ({ files: unwrap(await need().changes(root, base, target ?? null)).map((f) => ({ ...f })) }));
  port.handle(filesDiff, async ({ root, path, base, maxBytes, target }) => unwrap(await need().diff(root, path, base, maxBytes, target ?? null)));
  port.handle(filesCheckpoint, async ({ root, ref }) => ({ commit: unwrap(await need().checkpoint(root, ref)) }));
  port.handle(filesDropRefs, async ({ root, prefix }) => ({ dropped: unwrap(await need().dropRefs(root, prefix)) }));
  port.handle(filesRestore, async ({ root, commit, safetyRef }) => unwrap(await need().restore(root, commit, safetyRef)));
  port.handle(filesHead, async ({ root }) => ({ head: unwrap(await need().head(root)) }));
  port.handle(filesBranchBase, async ({ root }) => unwrap(await need().branchBase(root)));
  port.handle(filesWatch, async ({ watchId, root, paths }) => {
    watches.get(watchId)?.();
    const stop = unwrap(
      await need().watch(root, paths, (notice) => {
        void port.request(filesChanged, { watchId, paths: [...notice.paths].slice(0, 1000) }).then((sent) => {
          if (!sent.ok) {
            watches.get(watchId)?.();
            watches.delete(watchId);
          }
        });
      })
    );
    watches.set(watchId, stop);
    return {};
  });
  port.handle(filesUnwatch, async ({ watchId }) => {
    watches.get(watchId)?.();
    watches.delete(watchId);
    return {};
  });
}

/**
 * 项目 Git bundle 导入（docs/design/project-git-access.md 第二个增量）：只有显式注入的导入器才注册，
 * 不注入的 Worker 连 handler 都没有（hub 侧靠 hello 能力在发送前拒绝）。
 *
 * 同一时刻只跑一个导入：它要写工作目录的 object store 与一个专用 ref，并发没有收益、失败也更难解释。
 * 只有导入器 settle 后才释放（取消 / 超时也不提前放行）。导入器自己已经失败关闭校验路径、源地址、
 * base64 / SHA 与 ref；这里只做排队和错误 code 翻译，响应文案固定且中性（不外传导入器 message / 抛错原文）。
 */
export function serveProjectGitBundleImport(port: RpcPort, importer: ProjectGitBundleImporter): void {
  let busy = false;
  port.handle(wsImportProjectGitBundle, async (input) => {
    if (busy) throw new RpcFailure('conflict', '这台 Worker 正在导入另一个项目 Git bundle，稍后再试');
    busy = true;
    try {
      const outcome = await importer.importBundle(input);
      if (!outcome.ok) {
        // 只翻译 code，不回传导入器的 message：响应里不能出现路径 / Git 原始输出等上下文。
        switch (outcome.error.code) {
          case 'invalid':
            throw new RpcFailure('invalid', '项目 Git bundle 导入参数或对象校验未通过，未创建 ref');
          case 'conflict':
            throw new RpcFailure('conflict', '工作目录状态与项目 Git bundle 导入冲突，未创建 ref');
          case 'forbidden':
            throw new RpcFailure('forbidden', '项目 Git bundle 导入被拒绝');
          case 'not_found':
            throw new RpcFailure('not_found', '项目 Git bundle 导入的目标不存在');
          case 'not_implemented':
            throw new RpcFailure('unsupported', '这台 Worker 未实现项目 Git bundle 导入');
          default:
            throw new RpcFailure('failed', '项目 Git bundle 导入失败（结果未知；先核对 ref，不要自动重放）');
        }
      }
      return outcome.value;
    } catch (error) {
      // 导入器抛出的原始错误也不外泄：固定中性文案，避免通道把底层信息原样带到 hub。
      if (error instanceof RpcFailure) throw error;
      throw new RpcFailure('failed', '项目 Git bundle 导入失败（结果未知；先核对 ref，不要自动重放）');
    } finally {
      busy = false;
    }
  });
}
