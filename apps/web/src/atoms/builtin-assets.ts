import type { BuiltinAssetView, BrowserStatusDto } from '@agent-hub/contract';

/** 一项内置资产此刻该给什么操作。 */
export type BuiltinAction = 'enable' | 'secrets' | 'enabled' | 'update' | 'off' | 'clash';

export function builtinAction(view: Pick<BuiltinAssetView, 'enabled' | 'secrets' | 'clash'>): BuiltinAction {
  if (view.enabled) {
    if (!view.enabled.on) return 'off';
    return view.enabled.update ? 'update' : 'enabled';
  }
  if (view.clash) return 'clash';
  return view.secrets.some((secret) => !secret.set) ? 'secrets' : 'enable';
}

/** 启用前还要填的密钥。 */
export const missingSecrets = (view: Pick<BuiltinAssetView, 'secrets'>) => view.secrets.filter((secret) => !secret.set);

/** 浏览器那一行的一句话：几台机器有、几台没有。 */
export function browserSummary(workers: readonly Pick<BrowserStatusDto, 'ready' | 'online'>[]): string {
  if (workers.length === 0) return '还没有机器';
  const ready = workers.filter((worker) => worker.ready).length;
  if (ready === workers.length) return `${ready} 台机器都装好了 Chromium`;
  return `${ready}/${workers.length} 台机器装了 Chromium`;
}

export const BUILTIN_KIND_TEXT: Readonly<Record<BuiltinAssetView['kind'], string>> = { skill: '技能', instruction: '指令', mcp: 'MCP' };
