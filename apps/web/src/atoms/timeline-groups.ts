/**
 * 时间线 v2 的分组（纯逻辑，不碰 DOM）：每轮里连续的「干活」块（工具调用 + 思考）并成一个工作组，
 * 组头一行写摘要（几步、读/改/命令各几次、失败几处、用时），可以整组收起。
 *
 * - 至少两个工具调用才成组；只有一个就照旧单独画一行，不为它多套一层。
 * - 最后一轮（以及正在跑的那一轮）默认展开；更早、已经结束的轮默认收起——往回翻时看到的是摘要。
 * - 失败分级：同一组里失败之后，同类工具又成功了，算「可恢复」（警告色）；否则是真失败（危险色）。
 */
import { toolRowKind, type ToolRowKind } from './tool-rows.ts';
import { toolView } from './tool-format.ts';

interface Groupable {
  readonly kind: string;
  readonly seq: number;
}
interface ToolLike extends Groupable {
  readonly kind: 'tool';
  readonly name: string;
  readonly input: string;
  readonly result: { readonly ok: boolean; readonly durationMs: number } | null;
}

export interface WorkSummary {
  readonly steps: number;
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

export function groupTimeline<B extends Groupable>(blocks: readonly B[], opts: { readonly running: boolean }): TimelineItem<B>[] {
  // 先标出每块属于第几轮（问话开新一轮）
  let turn = 0;
  const turnOf = blocks.map((block) => (block.kind === 'prompt' ? ++turn : turn));
  const lastTurn = turn;
  const out: TimelineItem<B>[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (!isWork(blocks[i]!)) {
      out.push({ type: 'block', block: blocks[i]!, index: i, recovered: false });
      i += 1;
      continue;
    }
    let j = i;
    while (j < blocks.length && isWork(blocks[j]!)) j += 1;
    const run = blocks.slice(i, j).map((block, k) => ({ block, index: i + k }));
    const tools = run.filter((item) => isTool(item.block)) as { block: B & ToolLike; index: number }[];
    const probes = tools.map((item) => ({ kind: toolRowKind(item.block.name, toolView(item.block.name, item.block.input)), ok: item.block.result === null ? null : item.block.result.ok }));
    const rec = recoveredFailures(probes);
    const recoveredIdx = new Set([...rec].map((k) => tools[k]!.index));
    const items = run.map((item) => ({ ...item, recovered: recoveredIdx.has(item.index) }));
    if (tools.length < 2) {
      for (const item of items) out.push({ type: 'block', ...item });
    } else {
      const counts: Partial<Record<ToolRowKind, number>> = {};
      for (const probe of probes) counts[probe.kind] = (counts[probe.kind] ?? 0) + 1;
      const failed = probes.filter((probe) => probe.ok === false).length - rec.size;
      const running = probes.some((probe) => probe.ok === null);
      const groupTurn = turnOf[i]!;
      const isLastTurn = groupTurn === lastTurn;
      const live = opts.running && isLastTurn && j === blocks.length;
      out.push({
        type: 'work',
        key: `work-${blocks[i]!.seq}`,
        items,
        summary: {
          steps: tools.length,
          counts,
          failed,
          recovered: rec.size,
          durationMs: tools.reduce((sum, item) => sum + (item.block.result?.durationMs ?? 0), 0),
          running
        },
        open: isLastTurn || running || failed > 0,
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

/** 组头的分类计数：「改动 2 · 命令 4 · 读取 3」。 */
export function summaryCounts(summary: WorkSummary): string {
  return ORDER.filter((kind) => (summary.counts[kind] ?? 0) > 0)
    .map((kind) => `${KIND_LABEL[kind]} ${summary.counts[kind]}`)
    .join(' · ');
}

/** 1.2s / 45s / 3m12s。 */
export function durationText(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
