/** 只汇总相邻的活动；正文、操作和状态块留在原位并结束当前组。 */
import { toolRowKind, type ToolRowKind } from './tool-rows.ts';
import { toolView } from './tool-format.ts';

interface Groupable {
  readonly kind: string;
  readonly seq: number;
  readonly queued?: boolean;
}
interface ToolLike extends Groupable {
  readonly kind: 'tool';
  readonly name: string;
  readonly input: string;
  readonly result: { readonly ok: boolean; readonly durationMs: number } | null;
}

export interface WorkSummary {
  readonly steps: number;
  readonly thinking: number;
  readonly counts: Readonly<Partial<Record<ToolRowKind, number>>>;
  /** 最终没救回来的失败数。 */
  readonly failed: number;
  /** 失败后同类又成功了的次数。 */
  readonly recovered: number;
  readonly durationMs: number;
  /** 组里还有没结束的调用。 */
  readonly running: boolean;
}

export type TimelineItem<B extends Groupable> =
  | { readonly type: 'block'; readonly block: B; readonly index: number; readonly recovered: boolean }
  | {
      readonly type: 'work';
      readonly key: string;
      readonly items: readonly { readonly block: B; readonly index: number; readonly recovered: boolean }[];
      readonly summary: WorkSummary;
      /** 默认展开吗（用户点过以用户为准，那是组件的事）。 */
      readonly open: boolean;
      /** 正在跑的那一组：组头用流光字。 */
      readonly live: boolean;
    };

const isWork = (block: Groupable) => block.kind === 'tool' || block.kind === 'thinking';
const isTool = (block: Groupable): block is ToolLike => block.kind === 'tool';

/** 一组工具调用里哪些失败「之后同类又成功了」。按下标返回。 */
export function recoveredFailures(tools: readonly { kind: ToolRowKind; ok: boolean | null }[]): Set<number> {
  const out = new Set<number>();
  tools.forEach((tool, index) => {
    if (tool.ok !== false) return;
    if (tools.slice(index + 1).some((later) => later.kind === tool.kind && later.ok === true)) out.add(index);
  });
  return out;
}

export function groupTimeline<B extends Groupable>(blocks: readonly B[], opts: {
  readonly running: boolean;
  /** 显式显示/隐藏设置及需要立即显示的问题由调用方判断。 */
  readonly groupable?: (block: B) => boolean;
}): TimelineItem<B>[] {
  const groupable = (block: B) => isWork(block) && (opts.groupable?.(block) ?? true);
  const lastPrompt = blocks.reduce((last, block, index) => block.kind === 'prompt' && !block.queued ? index : last, -1);
  // 等待发送的问话不应抢走仍在运行的活动组的状态。
  let lastActiveIndex = blocks.length - 1;
  while (lastActiveIndex >= 0 && blocks[lastActiveIndex]!.kind === 'prompt' && blocks[lastActiveIndex]!.queued) lastActiveIndex -= 1;
  const out: TimelineItem<B>[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (!groupable(blocks[i]!)) {
      out.push({ type: 'block', block: blocks[i]!, index: i, recovered: false });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < blocks.length && groupable(blocks[j]!)) j += 1;
    const run = blocks.slice(i, j).map((block, k) => ({ block, index: i + k }));
    const tools = run.filter((item) => isTool(item.block)) as { block: B & ToolLike; index: number }[];
    const probes = tools.map((item) => ({ kind: toolRowKind(item.block.name, toolView(item.block.name, item.block.input)), ok: item.block.result === null ? null : item.block.result.ok }));
    const rec = recoveredFailures(probes);
    const recoveredIdx = new Set([...rec].map((k) => tools[k]!.index));
    const items = run.map((item) => ({ ...item, recovered: recoveredIdx.has(item.index) }));
    {
      const counts: Partial<Record<ToolRowKind, number>> = {};
      for (const probe of probes) counts[probe.kind] = (counts[probe.kind] ?? 0) + 1;
      const failed = probes.filter((probe) => probe.ok === false).length - rec.size;
      const running = probes.some((probe) => probe.ok === null);
      const live = opts.running && i > lastPrompt && j - 1 === lastActiveIndex;
      out.push({
        type: 'work',
        // 流式思考的 seq 会随每个 delta 更新；块的位置在追加过程中稳定。
        key: `work-${i}`,
        items,
        summary: {
          steps: tools.length,
          thinking: run.filter((item) => item.block.kind === 'thinking').length,
          counts,
          failed,
          recovered: rec.size,
          durationMs: tools.reduce((sum, item) => sum + (item.block.result?.durationMs ?? 0), 0),
          running
        },
        open: false,
        live
      });
    }
    i = j;
  }
  return out;
}

const KIND_LABEL: Readonly<Record<ToolRowKind, string>> = {
  read: '读取',
  grep: '搜索',
  list: '列出',
  shell: '命令',
  edit: '改动',
  fetch: '抓取',
  agent: '子代理',
  plan: '计划',
  other: '其他'
};

const ORDER: readonly ToolRowKind[] = ['edit', 'shell', 'read', 'grep', 'list', 'fetch', 'agent', 'plan', 'other'];

/** 组头的分类计数：「思考 1 · 改动 2 · 命令 4 · 读取 3」。 */
export function summaryCounts(summary: WorkSummary): string {
  const parts = summary.thinking > 0 ? [`思考 ${summary.thinking}`] : [];
  for (const kind of ORDER) {
    const count = summary.counts[kind] ?? 0;
    if (count > 0) parts.push(`${KIND_LABEL[kind]} ${count}`);
  }
  return parts.join(' · ');
}

/** 1.2s / 45s / 3m12s。 */
export function durationText(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
