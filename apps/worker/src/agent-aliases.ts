import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentAliasesProblem, type AgentAlias, type AgentRuntime, type HarnessReadiness, type HarnessSelfCheck } from '@agent-hub/domain';

/**
 * 自定义运行时别名（CAP-1）在 worker 侧的落地：
 * 读 `$WORKER_STATE_DIR/agents.json` → 重建 harness → 就地替换 → 原子写回。
 *
 * 正在跑的会话不受影响：它们拿着的是旧 runtime 对象，替换只改「以后新建会话从哪找 runtime」。
 */

/** 重建出来的那一套东西（`buildHarness` 的返回值）。 */
export interface BuiltAliasHarness {
  readonly runtimes: readonly AgentRuntime[];
  readonly probes: readonly HarnessReadiness[];
  readonly selfChecks?: readonly HarnessSelfCheck[];
  readonly summaries?: readonly string[];
}

export interface ApplyAgentAliasDeps {
  /** 落盘位置：`$WORKER_STATE_DIR/agents.json`。 */
  readonly stateFile: string;
  /** 用新的别名表重建 harness；null = 回到 ACP_AGENTS。失败要 throw。 */
  rebuild(aliases: readonly AgentAlias[] | null): Promise<BuiltAliasHarness>;
  /** 就地替换 runtimes（worker 传可变数组的 splice，link 里的 find/map 立刻看到新内容）。 */
  replaceRuntimes(runtimes: readonly AgentRuntime[]): void;
  /** 换 harness 就绪探测，顺带清掉旧的模型自检结果。 */
  replaceProbes(probes: readonly HarnessReadiness[], selfChecks?: readonly HarnessSelfCheck[]): Promise<void> | void;
  /** 测试可以换掉写盘；默认原子写（tmp + rename），null = 删掉文件。 */
  writeFile?(file: string, content: string | null): void;
  log(message: string): void;
}

/** 原子写：先写同目录临时文件再 rename，重启 / 断电时不会读到半截 JSON。null 删除文件。 */
export function writeAliasesFile(file: string, content: string | null): void {
  if (content === null) {
    try {
      rmSync(file, { force: true });
    } catch {
      // 删不掉不影响内存里的状态
    }
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * 读落盘的别名表：文件不存在 = 从没配过（null，走 ACP_AGENTS）；
 * 内容不合法也按「没配过」处理，只记一行日志——不能因为一份坏配置让 worker 起不来。
 */
export function readAgentAliases(file: string, log: (message: string) => void): readonly AgentAlias[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`读 ${file} 失败：${(error as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`${file} 不是合法 JSON，按「没配过」处理（走 ACP_AGENTS）`);
    return null;
  }
  const problem = agentAliasesProblem(parsed);
  if (problem !== null) {
    log(`${file} 内容不合法（${problem}），按「没配过」处理（走 ACP_AGENTS）`);
    return null;
  }
  const aliases = parsed as readonly AgentAlias[];
  return aliases.length > 0 ? aliases : null;
}

/**
 * hub 推来新别名时热应用：重建 → 落盘 → 替换。
 *
 * 顺序上**先重建再落盘**：配置有问题时旧 runtime 保持不动、agents.json 也不改，
 * 下次重启不会带着一份坏配置起不来。
 */
export async function applyAgentAliases(aliases: readonly AgentAlias[] | null, deps: ApplyAgentAliasDeps): Promise<boolean> {
  const next = aliases !== null && aliases.length > 0 ? aliases : null;
  let harness: BuiltAliasHarness;
  try {
    harness = await deps.rebuild(next);
  } catch (error) {
    deps.log(`运行时别名更新失败：${error instanceof Error ? error.message : String(error)}，继续用旧的`);
    return false;
  }
  try {
    (deps.writeFile ?? writeAliasesFile)(deps.stateFile, next === null ? null : `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    // 写不进去也要先把内存里的换掉：hub 是权威，重启后它会再推一次
    deps.log(`运行时别名落盘失败（${(error as Error).message}），本次仍按新别名运行`);
  }
  try {
    deps.replaceRuntimes(harness.runtimes);
    await deps.replaceProbes(harness.probes, harness.selfChecks);
  } catch (error) {
    deps.log(`运行时别名已重建但替换失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  for (const summary of harness.summaries ?? []) deps.log(summary);
  deps.log(next === null ? '运行时别名已清空，回到 ACP_AGENTS' : `运行时别名已更新：${next.length} 个`);
  return true;
}
