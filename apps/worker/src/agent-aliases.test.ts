import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAlias, AgentRuntime, HarnessReadiness, HarnessSelfCheck } from '@agent-hub/domain';
import { applyAgentAliases, readAgentAliases, type BuiltAliasHarness } from './agent-aliases.ts';

const alias = (id: string): AgentAlias => ({ id, label: `${id} 的显示名`, command: id, args: ['--acp'] });

const probe = (agentId: string): HarnessReadiness => ({
  agentId,
  probe: async () => ({ readiness: { state: 'ready' }, models: [], defaultModel: '' })
});

function harness(runtimes: readonly AgentRuntime[]): BuiltAliasHarness {
  return {
    runtimes,
    probes: runtimes.map((_runtime, index) => probe(`agent-${index}`)),
    selfChecks: [],
    summaries: [`${runtimes.length} 个 harness`]
  };
}

test('readAgentAliases：没文件 = null；坏 JSON / 不合法 = null 并记日志；合法就返回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-aliases-'));
  const file = join(dir, 'agents.json');
  const logs: string[] = [];

  assert.equal(readAgentAliases(file, (message) => logs.push(message)), null);

  writeFileSync(file, '{oops');
  assert.equal(readAgentAliases(file, (message) => logs.push(message)), null);
  assert.match(logs.at(-1) ?? '', /不是合法 JSON/);

  writeFileSync(file, JSON.stringify([{ id: 'pi', label: 'x', command: 'x', args: [] }]));
  assert.equal(readAgentAliases(file, (message) => logs.push(message)), null);
  assert.match(logs.at(-1) ?? '', /内容不合法/);

  writeFileSync(file, JSON.stringify([alias('a')]));
  assert.deepEqual(readAgentAliases(file, (message) => logs.push(message)), [alias('a')]);

  writeFileSync(file, '[]');
  assert.equal(readAgentAliases(file, (message) => logs.push(message)), null);
});

test('applyAgentAliases：成功 = 重建 → 写文件 → 替换，并打日志', async () => {
  const next: BuiltAliasHarness = harness([{ id: 'alias-a' } as unknown as AgentRuntime]);
  const rebuilt: (readonly AgentAlias[] | null)[] = [];
  const written: (string | null)[] = [];
  const replacedRuntimes: (readonly AgentRuntime[])[] = [];
  const replacedProbes: HarnessReadiness[][] = [];
  const logs: string[] = [];

  const result = await applyAgentAliases([alias('a')], {
    stateFile: '/tmp/agents.json',
    rebuild: async (aliases) => {
      rebuilt.push(aliases);
      return next;
    },
    replaceRuntimes: (runtimes) => replacedRuntimes.push(runtimes),
    replaceProbes: (probes) => {
      replacedProbes.push([...probes]);
    },
    writeFile: (_file, content) => written.push(content),
    log: (message) => logs.push(message)
  });

  assert.equal(result, true);
  assert.deepEqual(rebuilt, [[alias('a')]]);
  assert.deepEqual(JSON.parse(written[0] ?? 'null'), [alias('a')]);
  assert.deepEqual(replacedRuntimes, [next.runtimes]);
  assert.deepEqual(replacedProbes, [[...next.probes]]);
  assert.ok(logs.includes('运行时别名已更新：1 个'));
});

test('applyAgentAliases：重建失败 = 保持旧值、不写文件、不动 runtimes', async () => {
  const written: (string | null)[] = [];
  const replaced: (readonly AgentRuntime[])[] = [];
  const logs: string[] = [];

  const result = await applyAgentAliases([alias('a')], {
    stateFile: '/tmp/agents.json',
    rebuild: async () => {
      throw new Error('命令解析失败');
    },
    replaceRuntimes: (runtimes) => replaced.push(runtimes),
    replaceProbes: () => {
      throw new Error('不该走到这里');
    },
    writeFile: (_file, content) => written.push(content),
    log: (message) => logs.push(message)
  });

  assert.equal(result, false);
  assert.equal(written.length, 0);
  assert.equal(replaced.length, 0);
  assert.match(logs[0] ?? '', /运行时别名更新失败：命令解析失败，继续用旧的/);
});

test('applyAgentAliases：空数组 / null = 删掉落盘文件，回到 ACP_AGENTS', async () => {
  const next = harness([]);
  const written: (string | null)[] = [];
  const logs: string[] = [];

  const result = await applyAgentAliases([], {
    stateFile: '/tmp/agents.json',
    rebuild: async () => next,
    replaceRuntimes: () => undefined,
    replaceProbes: () => undefined,
    writeFile: (_file, content) => written.push(content),
    log: (message) => logs.push(message)
  });

  assert.equal(result, true);
  assert.deepEqual(written, [null]);
  assert.ok(logs.includes('运行时别名已清空，回到 ACP_AGENTS'));
});

test('writeAliasesFile：原子写后读得回来，null 删文件', async () => {
  const { writeAliasesFile } = await import('./agent-aliases.ts');
  const dir = mkdtempSync(join(tmpdir(), 'agent-aliases-'));
  const file = join(dir, 'nested', 'agents.json');
  writeAliasesFile(file, JSON.stringify([alias('a')]));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [alias('a')]);
  writeAliasesFile(file, null);
  assert.throws(() => readFileSync(file, 'utf8'));
});

test('HarnessSelfCheck 类型不被写死：probes 可带自检一起换', async () => {
  const check: HarnessSelfCheck = { agentId: 'a', run: async () => ({ ok: true, model: 'm', at: 1 }) };
  const captured: (readonly HarnessSelfCheck[] | undefined)[] = [];
  await applyAgentAliases([alias('a')], {
    stateFile: '/tmp/agents.json',
    rebuild: async () => ({ ...harness([]), selfChecks: [check] }),
    replaceRuntimes: () => undefined,
    replaceProbes: (_probes, selfChecks) => {
      captured.push(selfChecks);
    },
    writeFile: () => undefined,
    log: () => undefined
  });
  assert.deepEqual(captured, [[check]]);
});
