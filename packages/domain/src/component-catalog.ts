import { conflict, invalid, notFound, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import type { ComponentPin, ComponentProvides } from './runtime-bundle.ts';
import type { WorkerStatus } from './worker.ts';

/**
 * 运行时套件 P2（ADR 0021 §4–§9）：hub 的组件目录 + 安装计划。
 * - 目录里每一项钉死一个 npm 制品（包名 + 确切版本 + 下载地址 + sha512），是 cluster_admin 审过才能装的「已发布版本」；
 * - 第三方（来源是公共 npm）一律按 global 资产审核：只有 cluster_admin（asset.publish_global）能批（决定 4）；
 * - 安装脚本默认允许（决定 8），但审核时必须看得到：目录项带着顶层包的 preinstall / install / postinstall 原文。
 */

export type CatalogStatus = 'pending' | 'approved' | 'rejected';
export const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall'] as const;

/** 能装组件的运行时（P3 起加了 opencode：v2 插件，按 file:// 路径进 OPENCODE_CONFIG_CONTENT.plugins）。 */
export type ComponentRuntime = 'pi' | 'opencode';
export const COMPONENT_RUNTIMES: readonly ComponentRuntime[] = ['pi', 'opencode'];

/** 一次审核意见（P3 双人审核：要求 N 个不同的 cluster_admin 批准）。 */
export interface CatalogApproval {
  readonly by: string;
  readonly at: number;
  readonly note: string | null;
}

export interface CatalogComponent {
  /** hub 内的组件 id（目录名、钉住的 id），不是 npm 包名。 */
  readonly id: string;
  readonly runtime: ComponentRuntime;
  /** 来源：npm（默认，老目录项没有这个字段）或钉在某个提交上的 git 仓库（P4）。 */
  readonly source?: 'npm' | 'git';
  /** git 来源：https 仓库地址 + 40 位提交号。 */
  readonly gitUrl?: string;
  readonly commit?: string;
  /** 已有的批准（双人审核时攒够 requiredApprovals 个才变 approved）。 */
  readonly approvals?: readonly CatalogApproval[];
  readonly requiredApprovals?: number;
  readonly packageName: string;
  readonly version: string;
  /** npm 制品的下载地址（tarball）与 sha512：Worker 装完后对着锁文件逐项核对（借鉴 paseo 的做法）。 */
  readonly resolved: string;
  readonly integrity: string;
  readonly provides: readonly ComponentProvides[];
  /** 顶层包的安装脚本原文（审核依据）；空对象 = 没有。 */
  readonly scripts: Readonly<Record<string, string>>;
  /** 依赖个数（提示审核人：传递依赖的脚本也会跑）。 */
  readonly dependencyCount: number;
  readonly status: CatalogStatus;
  readonly submittedBy: string;
  readonly submittedAt: number;
  readonly reviewedBy: string | null;
  readonly reviewedAt: number | null;
  readonly reviewNote: string | null;
}

/** 钉在某台机器上的组件（期望状态，§7）。 */
export interface WorkerComponentPin extends ComponentPin {
  readonly workerId: string;
  readonly installedBy: string;
  readonly installedAt: number;
}

export const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
export const EXACT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/;
export const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
export const GIT_COMMIT = /^[0-9a-f]{40}$/;
/** 只收 https 的公开仓库地址（不带账号密码、不带 #/?）。 */
export const GIT_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~\/-]{1,300}$/;
export const GIT_INTEGRITY = /^git:[0-9a-f]{40}$/;
export const gitIntegrity = (commit: string): string => `git:${commit}`;
/** npm 认的 git 依赖写法：git+https://…#<commit>。 */
export const gitSpec = (url: string, commit: string): string => `git+${url}#${commit}`;
const CAPABILITY = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]*)+$/;

/** npm registry 的版本元数据里我们用到的那几项（hub 提交目录项时查一次）。 */
export interface NpmArtifactInfo {
  readonly name: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencyCount: number;
}

export interface ComponentSubmission {
  id: string;
  packageName: string;
  version: string;
  provides: readonly ComponentProvides[];
  runtime?: ComponentRuntime;
  git?: { url: string; commit: string };
}

export function validateSubmission(input: ComponentSubmission): Result<void, DomainError> {
  if (!COMPONENT_ID.test(input.id)) return err(invalid('组件 id 只能是小写字母、数字和 . _ -'));
  if (input.runtime && !COMPONENT_RUNTIMES.includes(input.runtime)) return err(invalid('这个运行时不支持装组件'));
  if (input.git) {
    if (!GIT_URL.test(input.git.url) || /@/.test(input.git.url)) return err(invalid('git 地址必须是 https，不能带账号或 #?'));
    if (!GIT_COMMIT.test(input.git.commit)) return err(invalid('git 来源必须钉在一个 40 位的提交号上，不收分支或 tag'));
  }
  if (!NPM_PACKAGE.test(input.packageName)) return err(invalid('npm 包名不对'));
  if (!EXACT_VERSION.test(input.version)) return err(invalid('版本必须是确切版本（X.Y.Z），不收范围、tag 或 latest'));
  if (input.provides.length > 16) return err(invalid('provides 最多 16 项'));
  for (const p of input.provides) if (!CAPABILITY.test(p.capability)) return err(invalid(`能力名不对：${p.capability}`));
  return ok(undefined);
}

/** 只留安装阶段会跑的脚本，原文限长（审核界面显示）。 */
export function installScriptsOf(scripts: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof scripts !== 'object' || scripts === null) return out;
  for (const name of INSTALL_SCRIPT_NAMES) {
    const value = (scripts as Record<string, unknown>)[name];
    if (typeof value === 'string') out[name] = value.slice(0, 4000);
  }
  return out;
}

export function checkArtifact(info: NpmArtifactInfo, packageName: string, version: string): Result<void, DomainError> {
  if (info.name !== packageName || info.version !== version) return err(invalid('registry 返回的包名或版本对不上'));
  if (!SHA512.test(info.integrity)) return err(invalid('这个版本没有 sha512 完整性哈希，不能钉住'));
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(info.resolved)) return err(invalid('制品地址必须是 https'));
  return ok(undefined);
}

export type ComponentAction = 'install_component' | 'uninstall_component';

/** 下发给 Worker 的组件任务（帧里只有固定形状的字段）。 */
export interface ComponentJobSpec {
  readonly componentId: string;
  readonly runtime: ComponentRuntime;
  /** git 来源（P4）：有它就按 git+https…#commit 装，integrity 是 git:<commit>。 */
  readonly git?: { readonly url: string; readonly commit: string };
  readonly packageName: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly provides: readonly ComponentProvides[];
  /** 恒为 true：安装脚本一律不执行（ADR 0021 决定 8）；留着给旧版 Worker 看。 */
  readonly ignoreScripts: true;
  /** 期望当前装着的版本（借鉴 paseo 的 compare-and-swap）：和 Worker 上的对不上就拒绝，防止审核后状态变了。null = 应该没装。 */
  readonly expectedCurrent: string | null;
}

/**
 * 能不能发组件任务。规则：离线拒绝；同时只跑一个任务；Worker 太旧（不报清单）拒绝；
 * 只装 approved 的目录项；运行时要在这台机器上；同版本且无漂移不重装（有漂移就是「修复」）。
 * 升级不看正在跑的会话：新版本只给新会话（决定 7），老会话还用旧目录。
 * 卸载要求没有忙着的会话在用这个运行时（会话进程按路径加载了它）。
 */
export function planComponentJob(
  worker: WorkerStatus | undefined,
  item: CatalogComponent | null,
  action: ComponentAction,
  pin: WorkerComponentPin | null,
  busySessions: number
): Result<{ readonly from: string | null; readonly repair: boolean }, DomainError> {
  if (!worker) return err(notFound('没有这台机器'));
  if (worker.state !== 'online') return err(conflict('这台机器不在线'));
  if (worker.runtimeJob?.state === 'running') return err(conflict('这台机器上已经有一个安装任务在跑'));
  if (!worker.inventory) return err(conflict('这台 Worker 版本太旧，不报组件清单：先更新它'));
  if (!worker.inventory.componentInstall) return err(conflict('这台 Worker 版本太旧，不支持安装组件：先更新它'));
  if (!item) return err(notFound('组件目录里没有这一项'));
  const actual = worker.inventory.components.find((c) => c.managedBy === 'hub' && c.id === item.id && c.runtime === item.runtime) ?? null;
  if (action === 'uninstall_component') {
    if (!pin && !actual) return err(conflict('这台机器上没有 hub 装的这个组件'));
    if (busySessions > 0) return err(conflict('还有会话在用这个运行时，结束后再卸载'));
    return ok({ from: actual?.version ?? pin?.version ?? null, repair: false });
  }
  if (item.status !== 'approved') return err(conflict('这个组件还没通过 cluster_admin 审核，不能安装'));
  if (!worker.inventory.runtimes.some((r) => r.agentId === item.runtime)) return err(conflict(`这台机器上没有 ${item.runtime}，先装运行时`));
  const drifted = worker.drift?.items.some((d) => d.componentId === item.id && d.kind !== 'external') ?? false;
  if (pin && pin.version === item.version && actual && actual.version === item.version && !drifted) return err(conflict(`已经装的就是 ${item.version}`));
  return ok({ from: actual?.version ?? null, repair: drifted });
}

/**
 * 调度过滤（§8，决定 6）：要求的能力必须在这台机器的**可信**能力里；不可信（漂移）的、外部组件的都不算。
 * 返回缺的能力；空数组 = 满足。
 */
export function missingCapabilities(worker: Pick<WorkerStatus, 'drift'>, requires: readonly string[]): string[] {
  const trusted = new Set((worker.drift?.trusted ?? []).map((c) => c.capability));
  return requires.filter((capability) => !trusted.has(capability));
}

/** Worker 报回来的组件任务结果（审计用）。 */
export interface ComponentJobResult {
  readonly integrity?: string;
  readonly integrityMismatch?: boolean;
  readonly ignoredScripts?: boolean;
  readonly scripts?: { package: string; script: string }[];
  readonly exitCode?: number | null;
  readonly durationMs?: number;
}

/** 目录主键：同一组件的每个版本各审一次（升级 = 提交新版本再审）。 */
export const catalogKey = (id: string, version: string): string => `${id}@${version}`;
