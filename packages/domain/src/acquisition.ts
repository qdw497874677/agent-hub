import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 组件目录项声明的「如何获得它所提供的能力」：有序策略，Worker 只执行这些泛型类型，
 * 不在代码里写死某个组件（例如 Chromium 只是一条目录数据）。
 *
 * - detect-system-binary：常见路径 + PATH 里的候选名，再用 verify.args 无头验证（独立 user-data-dir）；
 * - user-space-install：在已装好的 npm 包上跑一条安装命令（例如 playwright-core install chromium），再按 locate 找二进制；
 * - lighter-variant：上一档因缺库失败时的轻量退路（可带 fallbackArgs）；
 * - requires-root：终端失败态，不由 Worker 执行，只把命令和缺库清清楚楚告诉人。
 */
export const ACQUISITION_STRATEGY_TYPES = ['detect-system-binary', 'user-space-install', 'lighter-variant', 'requires-root'] as const;
export type AcquisitionStrategyType = (typeof ACQUISITION_STRATEGY_TYPES)[number];

const STRATEGY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface BinaryLocate {
  /** 环境变量名，非空且不是 "0" 时优先当作缓存根目录（例如 PLAYWRIGHT_BROWSERS_PATH）。 */
  readonly envRoot?: string;
  /** 相对 HOME / USERPROFILE 的子目录（例如 .cache/ms-playwright）。 */
  readonly homeSubdir?: string;
  readonly directoryPrefixes: readonly string[];
  readonly excludeDirectoryPrefixes?: readonly string[];
  /** 相对某个版本目录的候选二进制路径。 */
  readonly binaries: readonly string[];
}

export type AcquisitionStrategy =
  | {
      readonly type: 'detect-system-binary';
      readonly id: string;
      readonly names?: readonly string[];
      readonly paths?: readonly string[];
      /** 接到候选二进制后面的参数（不是 shell）。不写则只检查文件可执行。 */
      readonly verify?: { readonly args: readonly string[] };
    }
  | {
      readonly type: 'user-space-install';
      readonly id: string;
      /** 对「已装进暂存目录的包」跑的参数，例如 ['install', 'chromium']（由 Worker 用 node cli.js 执行）。 */
      readonly args: readonly string[];
      readonly locate: BinaryLocate;
      /** 装完用 ldd 核对缺库（Linux）；缺了就试下一条策略。 */
      readonly checkLibs?: boolean;
    }
  | {
      readonly type: 'lighter-variant';
      readonly id: string;
      readonly args: readonly string[];
      readonly fallbackArgs?: readonly string[];
      readonly locate: BinaryLocate;
      readonly checkLibs?: boolean;
    }
  | {
      readonly type: 'requires-root';
      readonly id: string;
      /** 给人看的命令（Worker 不执行）。 */
      readonly command: string;
      readonly args?: readonly string[];
    };

/** 一次选定的结果：写进 .component.json / 任务结果 / 清单，供状态查询和 MCP 启动注入。 */
export interface AcquisitionResolution {
  readonly strategy: string;
  readonly type: AcquisitionStrategyType;
  readonly path?: string;
  readonly capability?: string;
  readonly componentId?: string;
}

export interface McpExecutableBinding {
  readonly name: string;
  readonly executableArg: string;
}

export function isAcquisitionStrategyType(value: unknown): value is AcquisitionStrategyType {
  return ACQUISITION_STRATEGY_TYPES.includes(value as AcquisitionStrategyType);
}

export function formatRootCommand(strategy: Extract<AcquisitionStrategy, { type: 'requires-root' }>): string {
  return [strategy.command, ...(strategy.args ?? [])].join(' ');
}

export function readAcquisition(meta: unknown): AcquisitionResolution | null {
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as { acquisition?: unknown }).acquisition;
  if (!raw || typeof raw !== 'object') return null;
  const strategy = (raw as { strategy?: unknown }).strategy;
  const type = (raw as { type?: unknown }).type;
  const path = (raw as { path?: unknown }).path;
  const capability = (raw as { capability?: unknown }).capability;
  const componentId = (raw as { componentId?: unknown }).componentId;
  if (typeof strategy !== 'string' || strategy.length === 0 || strategy.length > 64) return null;
  if (!isAcquisitionStrategyType(type)) return null;
  if (path !== undefined && (typeof path !== 'string' || path.length === 0 || path.length > 512)) return null;
  if (capability !== undefined && (typeof capability !== 'string' || capability.length === 0 || capability.length > 128)) return null;
  if (componentId !== undefined && (typeof componentId !== 'string' || componentId.length === 0 || componentId.length > 64)) return null;
  return {
    strategy,
    type,
    ...(path ? { path } : {}),
    ...(capability ? { capability } : {}),
    ...(componentId ? { componentId } : {})
  };
}

function checkLocate(locate: unknown, where: string): Result<void, DomainError> {
  if (!locate || typeof locate !== 'object') return err(invalid(`${where}：要写 locate`));
  const rec = locate as Record<string, unknown>;
  if (rec['envRoot'] !== undefined && (typeof rec['envRoot'] !== 'string' || rec['envRoot'].length > 128)) {
    return err(invalid(`${where}：envRoot 不合法`));
  }
  if (rec['homeSubdir'] !== undefined && (typeof rec['homeSubdir'] !== 'string' || rec['homeSubdir'].length > 256 || rec['homeSubdir'].includes('..'))) {
    return err(invalid(`${where}：homeSubdir 不合法`));
  }
  if (!Array.isArray(rec['directoryPrefixes']) || rec['directoryPrefixes'].length === 0 || rec['directoryPrefixes'].length > 16) {
    return err(invalid(`${where}：directoryPrefixes 要有 1–16 项`));
  }
  if (!Array.isArray(rec['binaries']) || rec['binaries'].length === 0 || rec['binaries'].length > 16) {
    return err(invalid(`${where}：binaries 要有 1–16 项`));
  }
  const strings = [...rec['directoryPrefixes'], ...((rec['excludeDirectoryPrefixes'] as unknown[]) ?? []), ...rec['binaries']];
  if (strings.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 256)) {
    return err(invalid(`${where}：locate 路径过长或不是字符串`));
  }
  return ok(undefined);
}

function checkArgs(args: unknown, where: string, required: boolean): Result<void, DomainError> {
  if (args === undefined) return required ? err(invalid(`${where}：要写 args`)) : ok(undefined);
  if (!Array.isArray(args) || args.length > 16) return err(invalid(`${where}：args 最多 16 项`));
  if (required && args.length === 0) return err(invalid(`${where}：args 不能为空`));
  if (args.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 256)) return err(invalid(`${where}：args 每项最长 256`));
  return ok(undefined);
}

/** 提交目录项时核对策略（形状固定，避免自由文本进 Worker 命令）。 */
export function validateAcquisitionStrategies(strategies: readonly AcquisitionStrategy[] | undefined): Result<void, DomainError> {
  if (!strategies || strategies.length === 0) return ok(undefined);
  if (strategies.length > 8) return err(invalid('获取策略最多 8 条'));
  const seen = new Set<string>();
  for (const [index, strategy] of strategies.entries()) {
    const where = `策略 ${index + 1}`;
    if (!STRATEGY_ID.test(strategy.id)) return err(invalid(`${where}：id 只能是小写字母、数字和 . _ -`));
    if (seen.has(strategy.id)) return err(invalid(`${where}：id「${strategy.id}」重复`));
    seen.add(strategy.id);
    if (strategy.type === 'detect-system-binary') {
      if ((strategy.names?.length ?? 0) > 32 || (strategy.paths?.length ?? 0) > 32) return err(invalid(`${where}：候选名或路径太多`));
      if ((strategy.names?.length ?? 0) === 0 && (strategy.paths?.length ?? 0) === 0) return err(invalid(`${where}：至少要有 names 或 paths`));
      const namesOk = !(strategy.names ?? []).some((name) => !name || name.length > 128 || name.includes('/') || name.includes('\\'));
      const pathsOk = !(strategy.paths ?? []).some((path) => !path || path.length > 512);
      if (!namesOk || !pathsOk) return err(invalid(`${where}：候选名或路径不合法`));
      const verified = checkArgs(strategy.verify?.args, `${where}.verify`, false);
      if (!verified.ok) return verified;
    } else if (strategy.type === 'user-space-install' || strategy.type === 'lighter-variant') {
      const args = checkArgs(strategy.args, where, true);
      if (!args.ok) return args;
      if (strategy.type === 'lighter-variant') {
        const fallback = checkArgs(strategy.fallbackArgs, `${where}.fallbackArgs`, false);
        if (!fallback.ok) return fallback;
      }
      const locate = checkLocate(strategy.locate, where);
      if (!locate.ok) return locate;
    } else if (strategy.type === 'requires-root') {
      if (!strategy.command || strategy.command.length > 128 || /[\s;|&]/.test(strategy.command)) return err(invalid(`${where}：command 不合法`));
      const args = checkArgs(strategy.args, where, false);
      if (!args.ok) return args;
    } else {
      return err(invalid(`${where}：不认识的策略类型`));
    }
  }
  return ok(undefined);
}

/**
 * 给绑定了该能力的 MCP 服务器补上可执行文件参数。
 * 去掉已有的 flag（--executable-path 或 --executable-path=），再追加新的。
 */
export function withExecutableArg(args: readonly string[], flag: string, path: string): string[] {
  const out: string[] = [];
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) {
      if (i + 1 < args.length && !args[i + 1]!.startsWith('-')) i += 1;
      continue;
    }
    if (arg.startsWith(prefix)) continue;
    out.push(arg);
  }
  out.push(flag, path);
  return out;
}

export function mcpBindingOf(provides: readonly { readonly capability?: string; readonly mcp?: McpExecutableBinding }[] | undefined, name: string): McpExecutableBinding | null {
  if (!provides) return null;
  for (const entry of provides) {
    if (entry.mcp?.name === name && entry.mcp.executableArg) return entry.mcp;
  }
  return null;
}
