import type { Task } from './task.ts';
import type { LogAuthor, WorkLogEntry } from './work-log.ts';

/** 新会话首条提示前面垫的任务背景上限（UTF-8 字节）。 */
export const BRIEFING_MAX_BYTES = 4096;

const bytes = (text: string): number => new TextEncoder().encode(text).length;

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let out = text;
  while (out.length > 0 && bytes(out) > maxBytes - 4) out = out.slice(0, Math.floor(out.length * 0.9));
  return `${out}\n…`;
}

/** 背景里最多带几条较早的日志（每条压成一行）。 */
const OLDER_ENTRIES = 5;

export function authorLabel(author: LogAuthor): string {
  if (author.kind === 'system') return '系统';
  if (author.kind === 'user') return author.name ?? '用户';
  return `${author.agentId}${author.model ? `·${author.model}` : ''}`;
}

const oneLine = (text: string): string => {
  const line = text.split('\n').map((part) => part.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/**
 * 新会话的第一句话：先告诉 agent 这条任务是什么、做到哪了、最近几条日志写了什么。
 * entries 为最近的日志（新到旧）。最新一条人/agent 写的日志放全文，其余的压成一行。
 * 只在有内容可说时生成（光有标题不值得占上下文）；超过 4KB 先截正文、再截进展。
 * 不写进 journal——用户在对话里看到的仍是自己那句话。
 */
export function taskBriefing(task: Task, entries: readonly WorkLogEntry[]): string | null {
  const latest = entries.find((entry) => entry.author.kind !== 'system') ?? null;
  if (!task.goal && !task.summary && entries.length === 0) return null;
  const head = [`[agent-hub 任务背景] 任务：${task.title}`, task.goal ? `目标：${task.goal}` : null].filter(Boolean).join('\n');
  const tail = '（可用 agent-hub 的 MCP 工具 task_get / task_log_list / task_log_append 读写任务日志；收尾前请写一条日志：做完了什么 / 进行中 / 下一步 / 风险 / 关键文件。）\n[/任务背景]';
  const summaryText = task.summary && (!latest || !latest.body.includes(task.summary)) ? task.summary : null;
  const older = entries
    .filter((entry) => entry !== latest)
    .slice(0, OLDER_ENTRIES)
    .reverse()
    .map((entry) => `- #${entry.seq} ${authorLabel(entry.author)}：${oneLine(entry.body)}`);
  const olderPart = older.length > 0 ? `更早的日志：\n${older.join('\n')}` : null;
  let room = BRIEFING_MAX_BYTES - bytes(head) - bytes(tail) - 64;
  const summaryPart = summaryText ? `当前进展：\n${clip(summaryText, Math.floor(room / 4))}` : null;
  room -= summaryPart ? bytes(summaryPart) : 0;
  const olderClipped = olderPart ? clip(olderPart, Math.floor(room / 3)) : null;
  room -= olderClipped ? bytes(olderClipped) : 0;
  const latestPart = latest ? `最新日志（#${latest.seq}，${authorLabel(latest.author)}）：\n${clip(latest.body, room)}` : null;
  return [head, summaryPart, olderClipped, latestPart, tail].filter(Boolean).join('\n\n');
}
