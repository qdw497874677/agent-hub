import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITY_NAMES, type PreparedRuntime, type RuntimeAdapter, type RuntimeAdapterContext } from '@agent-hub/domain';

/**
 * 统一运行时适配器的一致性套件（docs/design/runtime-adapter-contract.md §5）。
 * 每个注册进 RUNTIME_ADAPTERS 的适配器都必须过：新增 agent 时不用另写一套检查。
 */

/** 永远不该出现在任何输出里的假密钥。 */
export const CONFORMANCE_SECRET = 'sk-CONFORMANCE-0000-do-not-leak';

/** 用户全局 agent 配置：适配器只许读，不许改（ADR 0013）。 */
export const GLOBAL_AGENT_CONFIGS = [
  '.pi/agent/models.json',
  '.pi/agent/settings.json',
  '.pi/agent/mcp.json',
  '.config/opencode/opencode.json',
  '.grok/config.toml'
];

export function fingerprint(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of GLOBAL_AGENT_CONFIGS) {
    const file = join(home, rel);
    out[rel] = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '-';
  }
  return out;
}

export interface ConformanceFixture {
  readonly home: string;
  readonly ctx: RuntimeAdapterContext;
  readonly logs: string[];
  cleanup(): void;
}

/** 一个与世隔绝的上下文：临时 HOME、命令全指向不存在的路径、环境里埋一个假密钥。 */
export function conformanceFixture(extraEnv: Record<string, string> = {}): ConformanceFixture {
  const home = mkdtempSync(join(tmpdir(), 'hub-conformance-'));
  const logs: string[] = [];
  const env: Record<string, string> = { PATH: '', HOME: home, HUB_CONFORMANCE_SECRET: CONFORMANCE_SECRET, ...extraEnv };
  return {
    home,
    logs,
    ctx: {
      env,
      home,
      toolShim: { command: process.execPath, args: ['--version'] },
      command: (name) => ({ command: join(home, 'missing-bin', name), hint: `找不到 ${name}` }),
      log: (message) => void logs.push(message),
      onAgentSessionRef: () => undefined,
      onOptions: () => undefined
    },
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

export interface ConformanceReport {
  readonly prepared: readonly PreparedRuntime[];
  readonly failures: readonly string[];
}

/** 跑一遍契约检查；返回失败清单（空 = 通过）。 */
export async function runRuntimeConformance(adapter: RuntimeAdapter, extraEnv: Record<string, string> = {}): Promise<ConformanceReport> {
  const failures: string[] = [];
  const fixture = conformanceFixture(extraEnv);
  const realHome = homedir();
  const before = fingerprint(realHome);
  try {
    const prepared = await adapter.prepare(fixture.ctx);
    if (prepared.length === 0) failures.push(`${adapter.id}: prepare 没产出任何 runtime`);
    for (const entry of prepared) {
      const d = entry.runtime.descriptor;
      const where = `${adapter.id}/${d.id}`;
      if (d.label.trim() === '') failures.push(`${where}: label 为空`);
      if (entry.readiness.agentId !== d.id) failures.push(`${where}: 就绪探测 agentId=${entry.readiness.agentId} 与 descriptor 不一致`);
      if (entry.installer && entry.installer.agentId !== d.id) failures.push(`${where}: 安装器 agentId 不一致`);
      for (const name of CAPABILITY_NAMES) if (!d.capabilities[name]) failures.push(`${where}: 能力矩阵缺 ${name}`);
      if (d.defaultModel !== '' && d.models.length > 0 && !d.models.includes(d.defaultModel)) failures.push(`${where}: 默认模型不在清单里`);
      const probe = await entry.readiness.probe();
      if (probe.readiness.state !== 'unavailable') failures.push(`${where}: 命令不存在时就绪探测应为 unavailable`);
      if (JSON.stringify(probe).includes(CONFORMANCE_SECRET)) failures.push(`${where}: 就绪探测泄露了环境里的密钥`);
      if (JSON.stringify(d).includes(CONFORMANCE_SECRET)) failures.push(`${where}: descriptor 泄露了环境里的密钥`);
    }
    if (fixture.logs.some((line) => line.includes(CONFORMANCE_SECRET))) failures.push(`${adapter.id}: 日志里出现密钥`);
    const leftovers = readdirSync(fixture.home);
    if (leftovers.length > 0) failures.push(`${adapter.id}: prepare 在 HOME 里写了文件：${leftovers.join(', ')}`);
    const after = fingerprint(realHome);
    for (const rel of GLOBAL_AGENT_CONFIGS) if (before[rel] !== after[rel]) failures.push(`${adapter.id}: 改动了全局配置 ~/${rel}`);
    return { prepared, failures };
  } finally {
    fixture.cleanup();
  }
}
