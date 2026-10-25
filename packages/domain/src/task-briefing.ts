import type { Task } from './task.ts';
import type { WorkLogEntry } from './work-log.ts';

/** 新会话首条提示前面垫的任务背景上限（UTF-8 字节）。 */
export const BRIEFING_MAX_BYTES = 4096;

const bytes = (text: string): number => new TextEncoder().encode(text).length;

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let out = text;
  while (out.length > 0 && bytes(out) > maxBytes - 4) out = out.slice(0, Math.floor(out.length * 0.9));
  return `${out}\n…`;
}

/**
 * 新会话的第一句话：先告诉 agent 这条任务是什么、做到哪了、上一位留了什么交接。
 * 只在有内容可说时生成（光有标题不值得占上下文）；超过 4KB 先截交接、再截摘要。
 * 不写进 journal——用户在对话里看到的仍是自己那句话。
 */
export function taskBriefing(task: Task, handoff: WorkLogEntry | null): string | null {
  if (!task.goal && !task.summary && !handoff) return null;
  const head = [`[agent-hub 任务背景] 任务：${task.title}`, task.goal ? `目标：${task.goal}` : null].filter(Boolean).join('\n');
  const tail = '（可用 agent-hub 的 MCP 工具 task_get / task_log_append 读写任务；收尾前请写一条 kind=handoff 的交接。）\n[/任务背景]';
  const summaryText = task.summary && (!handoff || handoff.body !== task.summary) ? task.summary : null;
  const room = BRIEFING_MAX_BYTES - bytes(head) - bytes(tail) - 64;
  const summaryPart = summaryText ? `当前摘要：\n${clip(summaryText, Math.floor(room / 2))}` : null;
  const handoffPart = handoff
    ? `最近交接（#${handoff.seq}）：\n${clip(handoff.body, room - (summaryPart ? bytes(summaryPart) : 0))}`
    : null;
  return [head, summaryPart, handoffPart, tail].filter(Boolean).join('\n\n');
}
