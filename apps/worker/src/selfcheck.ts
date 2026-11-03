/**
 * releases 布局的预检（ADR 0030 D2）：新版本装好之后、换上之前，在 staging 目录里跑一次。
 * 只检查「这份代码能不能起来」——模块都能加载、协议版本读得到、能跑的 runtime 表在；不连 hub、不碰会话。
 * 不 import main.ts（那会真的启动 Worker）。退出码 0 = 通过。
 */
const failures: string[] = [];
const check = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
  }
};

await check('contract', async () => {
  const contract = await import('@agent-hub/contract');
  if (typeof contract.PROTOCOL_VERSION !== 'number') throw new Error('PROTOCOL_VERSION 不存在');
});
await check('node-gateway', async () => {
  const gateway = await import('@agent-hub/node-gateway');
  if (typeof gateway.connectWorkerLink !== 'function') throw new Error('connectWorkerLink 不存在');
});
await check('domain', () => import('@agent-hub/domain'));
await check('runtimes', async () => {
  const { RUNTIME_ADAPTERS } = await import('./runtimes.ts');
  if (RUNTIME_ADAPTERS.length === 0) throw new Error('RUNTIME_ADAPTERS 是空的');
});

if (failures.length > 0) {
  console.error(`[selfcheck] 预检失败：\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('[selfcheck] ok');
