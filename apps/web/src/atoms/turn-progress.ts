import type { Block } from './live-core.ts';

/**
 * 「发了消息之后，agent 到底在不在动」——从发送到第一段输出之间有 1.5–12 秒空窗
 *（首次回合还要先拉起 agent 进程），界面上原来只有一行静态灰字，看着像卡住了。
 *
 * 这里只做判断，不碰 DOM、不碰网络、不轮询：时间由调用方给（`now`），
 * 开始时刻也由调用方记（`startedAt`），所以能在 node:test 里直接测——
 * 和 background-activity.ts 是同一套写法。
 */

/**
 * 这一轮此刻处在哪一段：
 * - `starting`：消息发出去了，之后还没有任何块（拉起进程、等首 token）；
 * - `waiting`：有块了，但只是登记信息（附件、批准卡之类），模型还没开口；
 * - `writing`：模型已经在输出（文本 / 思考）；
 * - `tool`：最后一块是工具调用，正等着工具回来。
 */
export type TurnPhase = 'starting' | 'waiting' | 'writing' | 'tool';

export interface TurnProgress {
  readonly phase: TurnPhase;
  /** 一行主文案：正在启动 / 正在输出 / 正在用 Bash… */
  readonly label: string;
  /** 从发送到现在的整秒数（不会为负）。 */
  readonly seconds: number;
  /** 给 title / aria-label 的完整说明：不悬停也能读懂这句在说什么。 */
  readonly detail: string;
}

export interface TurnProgressInput {
  readonly blocks: readonly Block[];
  /** 这一轮还在等回复吗（`waitingForReply` 的结果）。为假就什么都不显示。 */
  readonly awaiting: boolean;
  /** 这一轮开始的时刻（毫秒）。 */
  readonly startedAt: number;
  /** 现在（毫秒）。 */
  readonly now: number;
  /** 界面上怎么称呼这个 agent（`agent.label`）。 */
  readonly agentLabel: string;
}

/** 工具名最长显示 20 个字符，再长就截断——一行提示不该被一个 MCP 工具名撑开。 */
const TOOL_NAME_MAX = 20;

/**
 * 这一轮该显示什么；不该显示时返回 null（回合已结束 / 还没开口）。
 *
 * 只看最后一个 prompt 块之后的块：分叉继承来的历史、上一轮说过的话都属于之前，
 * 拿它们判断会把「刚发出去」误报成「已经在写」。没有 prompt 块（理论上不会发生）就用全部块。
 */
export function turnProgress({ blocks, awaiting, startedAt, now, agentLabel }: TurnProgressInput): TurnProgress | null {
  if (!awaiting) return null;

  let lastPrompt = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === 'prompt') {
      lastPrompt = index;
      break;
    }
  }
  const after = blocks.slice(lastPrompt + 1);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const last = after[after.length - 1];

  let phase: TurnPhase;
  let label: string;
  if (after.length === 0) {
    phase = 'starting';
    label = `正在启动 ${agentLabel}…`;
  } else if (last?.kind === 'tool') {
    phase = 'tool';
    label = `正在用 ${shortTool(last.name)}…`;
  } else if (after.some((block) => block.kind === 'text' || block.kind === 'thinking')) {
    phase = 'writing';
    label = '正在输出…';
  } else {
    // 只有 artifact / subagent / 批准卡这类登记信息：模型还没开口，别假装它在写。
    phase = 'waiting';
    label = '已发送，等待模型…';
  }

  // 「正在回复」四个字保留在这里：悬停、读屏、以及 e2e 的 `/正在回复/` 都认它。
  return { phase, label, seconds, detail: `${agentLabel} 正在回复：${label} 已等待 ${seconds} 秒` };
}

function shortTool(name: string): string {
  return name.length <= TOOL_NAME_MAX ? name : `${name.slice(0, TOOL_NAME_MAX - 1)}…`;
}
