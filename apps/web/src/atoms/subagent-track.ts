import { subagentStepCount, type Block } from './live-core.ts';
import { toolSummary, toolView } from './tool-format.ts';

/**
 * 子代理轨道的纯逻辑：把对话里的子代理块拍平成「一行一个」，
 * 再算出轨道上的分片计数、列表里的最近动态。不碰 DOM，能在 node:test 里测
 * （subagent-track.test.ts）。
 *
 * 为什么全完成时也保留轨道：用户明确要「一直显示」——回合结束后子代理还在跑、
 * 或者刚刚跑完想回头看一眼，都不该逼人滚回去找那张折叠卡。
 */

export type SubagentBlock = Extract<Block, { kind: 'subagent' }>;
export type SubagentStatus = SubagentBlock['status'];

/** 轨道只用三个桶：运行中 / 失败 / 完成。 */
export type SubagentBucket = 'running' | 'failed' | 'done';

export interface SubagentEntry {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  /** 显示名：title → agent → 「子代理」。 */
  readonly title: string;
  /** 报上来的 agent 名（可能没有，也可能和 title 一样）。 */
  readonly agent: string | null;
  readonly status: SubagentStatus;
  readonly bucket: SubagentBucket;
  readonly steps: number;
  /** 子时间线尾部最近一条 text / tool 的摘要；还没有输出就是 null。 */
  readonly activity: string | null;
}

/**
 * 取消不算完成——它没走完，按失败那一桶计，免得「全部完成」是在骗人。
 * 行内文字仍然是「已取消」，不把取消说成失败。
 */
export function subagentBucket(status: SubagentStatus): SubagentBucket {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  return 'failed';
}

export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'completed':
      return '完成';
  }
}

/** 状态文字的配色：轨道、列表、面板共用一份，免得三处说法不一致。 */
export const SUBAGENT_STATUS_CLASS: Record<SubagentStatus, string> = {
  running: 'text-accent',
  completed: 'text-sage',
  failed: 'text-rust',
  cancelled: 'text-tertiary'
};

/** 步数为 0 的时候说「暂无输出」，比「0 步」像句人话。 */
export function subagentStepsLabel(steps: number): string {
  return steps > 0 ? `${steps} 步` : '暂无输出';
}

function clip(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function entryOf(block: SubagentBlock): SubagentEntry {
  const agent = block.agent?.trim() ?? '';
  const title = block.title?.trim() ?? '';
  return {
    id: block.id,
    parentId: block.parentId,
    depth: block.depth,
    title: title !== '' ? title : agent !== '' ? agent : '子代理',
    agent: agent !== '' ? agent : null,
    status: block.status,
    bucket: subagentBucket(block.status),
    steps: subagentStepCount(block),
    activity: subagentActivity(block)
  };
}

/** 子时间线尾部最近一条 text / tool；尾部是嵌套子代理就往下看它自己的尾巴。 */
export function subagentActivity(block: SubagentBlock): string | null {
  for (let index = block.children.length - 1; index >= 0; index -= 1) {
    const child = block.children[index];
    if (child === undefined) continue;
    if (child.kind === 'text') {
      const text = clip(child.text);
      if (text !== '') return text;
      continue;
    }
    if (child.kind === 'tool') {
      const summary = clip(toolSummary(toolView(child.name, child.input)));
      if (summary !== '') return summary;
      continue;
    }
    if (child.kind === 'subagent') {
      const nested = subagentActivity(child);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * 深度优先、前序拍平：父在子前，兄弟按时间线顺序。
 * 只收 subagent 块，其他块不占轨道的位置。
 */
export function subagentEntries(blocks: readonly Block[]): readonly SubagentEntry[] {
  const out: SubagentEntry[] = [];
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.kind !== 'subagent') continue;
      out.push(entryOf(block));
      walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * 「2 运行中 · 1 失败 · 3 完成」——运行中排最前，0 的桶不出现。
 * 没有子代理返回 null（轨道那时根本不渲染）。
 */
export function subagentSummary(entries: readonly SubagentEntry[]): string | null {
  if (entries.length === 0) return null;
  let running = 0;
  let failed = 0;
  let done = 0;
  for (const entry of entries) {
    if (entry.bucket === 'running') running += 1;
    else if (entry.bucket === 'failed') failed += 1;
    else done += 1;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} 运行中`);
  if (failed > 0) parts.push(`${failed} 失败`);
  if (done > 0) parts.push(`${done} 完成`);
  return parts.join(' · ');
}

/** 轨道左侧那个环的颜色按这个走：有运行中就 accent，否则有失败就 rust，否则 sage。 */
export function subagentTone(entries: readonly SubagentEntry[]): SubagentBucket | null {
  if (entries.length === 0) return null;
  if (entries.some((entry) => entry.bucket === 'running')) return 'running';
  if (entries.some((entry) => entry.bucket === 'failed')) return 'failed';
  return 'done';
}

export function findSubagentBlock(blocks: readonly Block[], id: string): SubagentBlock | null {
  for (const block of blocks) {
    if (block.kind !== 'subagent') continue;
    if (block.id === id) return block;
    const nested = findSubagentBlock(block.children, id);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * 面板的返回栈：按 focus 里存的 id 栈依次解析，找不到的层级直接截断。
 * 返回空数组说明这一层已经不存在了（会话换了、块丢了），调用方该关面板。
 */
export function resolveSubagentPath(blocks: readonly Block[], path: readonly string[]): readonly SubagentBlock[] {
  const chain: SubagentBlock[] = [];
  for (const id of path) {
    const block = findSubagentBlock(blocks, id);
    if (block === null) break;
    chain.push(block);
  }
  return chain;
}
