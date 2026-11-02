import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, asTaskId } from '@agent-hub/domain';
import type { AgentRuntime, HarnessSelfCheck, ModelCheck, SessionEvent } from '@agent-hub/domain';

/** 自检会话的 id 前缀：Worker 据此不把它的 agent 会话号 / 可调项报给 hub。 */
export const SELF_CHECK_PREFIX = 'selfcheck-';
export const SELF_CHECK_PROMPT = '这是连通性自检，请只回复 OK 两个字母。';

/**
 * 通用的模型自检（只依赖 AgentRuntime 端口）：临时目录里开一个会话、问一句、看有没有回话。
 * 不带 hub 工具、不带资产；超时就算失败；结束一定 dispose 并删临时目录。
 */
export function runtimeSelfCheck(runtime: AgentRuntime, options: { readonly timeoutMs?: number; readonly now?: () => number } = {}): HarnessSelfCheck {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const now = options.now ?? Date.now;
  return {
    agentId: runtime.descriptor.id,
    async run(): Promise<ModelCheck> {
      const dir = mkdtempSync(join(tmpdir(), 'agent-hub-selfcheck-'));
      let model = '';
      const fail = (reason: string): ModelCheck => ({ ok: false, model, reason: reason.length > 1500 ? `${reason.slice(0, 1500)}…` : reason, at: now() });
      let timer: NodeJS.Timeout | undefined;
      let dispose: (() => Promise<void>) | null = null;
      const timeout = new Promise<ModelCheck>((resolve) => {
        timer = setTimeout(() => resolve(fail(`自检超时（${Math.round(timeoutMs / 1000)} 秒内没有回话）`)), timeoutMs);
        timer.unref?.();
      });
      const attempt = async (): Promise<ModelCheck> => {
        const started = await runtime.start({
          sessionId: asSessionId(`${SELF_CHECK_PREFIX}${runtime.descriptor.id}-${now()}`),
          taskId: asTaskId('selfcheck'),
          workspaceRoot: dir,
          resume: null,
          options: {}
        });
        if (!started.ok) return fail(started.error.message);
        const session = started.value;
        dispose = () => session.dispose();
        const current = session.options().find((option) => option.category === 'model')?.current;
        model = typeof current === 'string' ? current : '';
        let text = '';
        const ended = (async (): Promise<SessionEvent | null> => {
          for await (const event of session.events()) {
            if (event.kind === 'text') text += event.delta;
            if (event.kind === 'ended') return event;
          }
          return null;
        })();
        const sent = await session.prompt({ text: SELF_CHECK_PROMPT, parts: [] });
        if (!sent.ok) return fail(sent.error.message);
        const end = await ended;
        if (end && end.kind === 'ended' && end.outcome === 'done' && text.trim() !== '') return { ok: true, model, at: now() };
        if (end && end.kind === 'ended' && end.reason) return fail(end.reason);
        return fail('agent 没有返回任何内容（可能是模型/鉴权/网络问题）');
      };
      try {
        return await Promise.race([attempt().catch((error: unknown) => fail(`自检出错：${error instanceof Error ? error.message : String(error)}`)), timeout]);
      } finally {
        clearTimeout(timer);
        await (dispose as (() => Promise<void>) | null)?.().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}
