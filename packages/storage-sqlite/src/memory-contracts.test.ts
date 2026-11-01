import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultMemoryPolicy, createSpotCheckJob, defaultMemoryRegistry, expireJob, patternSecretFilter, rrfRanker, ruleDistiller } from '@agent-hub/domain';
import { distillerContract, governanceContract, maintenanceJobContract, memoryIndexContract, rankerContract, type ContractCase } from '@agent-hub/domain/testing/memory-contracts';
import { openSqliteStore } from './store.ts';

// 每个内置适配器 + SQLite 存储 / 索引都跑一遍契约（memory.md §16）。
const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const open = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-contract-'));
  dirs.push(dir);
  return openSqliteStore(join(dir, 'hub.db'));
};
const run = (cases: ContractCase[]) => cases.forEach((c) => test(c.name, () => c.run()));

run(memoryIndexContract('sqlite-fts', async () => (await open()).memory.index));
run(distillerContract('rule', ruleDistiller));
run(rankerContract('rrf', rrfRanker));
run(governanceContract('builtin', { secretFilter: patternSecretFilter, policy: createDefaultMemoryPolicy() }));
for (const job of [expireJob, createSpotCheckJob(() => 0)]) {
  run(maintenanceJobContract(job.id, job, async () => {
    const store = await open();
    return { store: store.memory.store, index: store.memory.index, now: Date.now() };
  }));
}
// 注册表装出来的组合件也要过同样的契约
const built = defaultMemoryRegistry().build({ index: { upsert: async () => {}, remove: async () => {}, indexed: async () => new Map(), query: async () => [] }, store: undefined as never });
run(distillerContract('registry.distiller', built.distiller));
run(governanceContract('registry', { secretFilter: built.secretFilter, policy: built.policy }));
