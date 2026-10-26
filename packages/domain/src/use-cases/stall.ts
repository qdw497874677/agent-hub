import type { SessionId } from '../ids.ts';
import type { Deps } from './deps.ts';
import { recordEvent } from './sessions.ts';

export interface StallPolicy {
  /** 一轮跑着但这么久没有任何新事件，就算「卡住了」。 */
  readonly idleMs: number;
  /** 提醒文字的开头：用它认出「已经提醒过」，避免每个巡检周期都再记一条。 */
  readonly marker: string;
}

/**
 * 找出「一轮还没结束、却很久没动静」的会话，各记一条 warn 诊断。
 *
 * 「一轮还没结束」= 最后一条事件不是 ended：用户在等回复，不是 agent 在等用户。
 * 只提醒、不擅自中断——模型可能只是在跑一个很慢的工具，停不停交给人。
 * 诊断事件本身会推进 journal，所以同一次卡顿只提醒一次；之后再有输出就重新计时。
 */
export async function flagStalledSessions(
  deps: Pick<Deps, 'artifacts' | 'now' | 'queue' | 'sessions' | 'stream'>,
  policy: StallPolicy
): Promise<SessionId[]> {
  const flagged: SessionId[] = [];
  for (const session of await deps.sessions.listAll()) {
    if (session.status !== 'running') continue;
    const done = await deps.queue.run(session.id, async () => {
      const last = (await deps.sessions.tail(session.id, 1))[0];
      if (!last || last.event.kind === 'ended') return false;
      if (last.event.kind === 'diagnostic' && last.event.text.startsWith(policy.marker)) return false;
      const idle = deps.now() - last.at;
      if (idle < policy.idleMs) return false;
      const minutes = Math.max(1, Math.round(idle / 60_000));
      const text = `${policy.marker}：已经 ${minutes} 分钟没有新输出，模型可能卡住了，可以点「中断」停下这一轮。`;
      const result = await recordEvent(deps, { sessionId: session.id, event: { kind: 'diagnostic', level: 'warn', text } });
      return result.ok;
    });
    if (done) flagged.push(session.id);
  }
  return flagged;
}
