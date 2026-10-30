import { useState } from 'react';
import type { ArtifactDto, CanvasDto, SessionDto } from './api.ts';
import { api } from './api.ts';
import { ChatBlock, DisplayMenu, Dropdown, MenuItem, useDisplaySettings } from './chat-blocks.tsx';
import { Composer } from './composer.tsx';
import { CONTINUE_DISABLED_HINT, ContinueDialog, canContinueElsewhere } from './continue-elsewhere.tsx';
import { ForkDialog, SessionDetails } from './inspector.tsx';
import { StatusPill } from './status.tsx';
import { attachmentsCapability } from './attachments.ts';
import { useStickToBottom } from './use-stick-to-bottom.ts';
import { sessionCommands } from './commands.ts';
import type { LiveSession } from './live.ts';

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly live: LiveSession | null;
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onBack: () => void;
  readonly onChanged: () => void;
  /** 换个地方继续之后跳到新会话。 */
  readonly onOpenSession: (sessionId: string) => void;
  readonly artifacts: readonly ArtifactDto[];
  readonly onChangeOption: (optionId: string, value: string | boolean) => Promise<void>;
}

/**
 * 专注对话：一条会话，整屏看。
 *
 * 画布回答「这些思路之间是什么关系」，这里回答「它到底说了什么」。
 * 两者不能合并——把对话塞进 320px 的右栏，人只能在里面翻跟头。
 */
export function FocusView({
  canvas,
  session,
  live,
  draft,
  onDraftChange,
  onBack,
  onChanged,
  onOpenSession,
  artifacts,
  onChangeOption
}: Props) {
  const [busy, setBusy] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [forkAt, setForkAt] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [settings, changeSettings] = useDisplaySettings();
  const scroller = useStickToBottom<HTMLDivElement>(session.id);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const blocks = live?.blocks ?? [];
  const status = live?.status ?? session.status;
  const reason = live?.reason ?? null;
  const agentLabel = agent?.label ?? session.agentId;
  const lastSeq = live?.lastSeq ?? session.lastSeq;
  const forkable = !busy && lastSeq > 0 && agent?.capabilities.fork.state !== 'denied';
  function startFork(seq: number) {
    setForkError(null);
    setForkAt(String(seq));
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hair px-2 md:px-3">
        <button className="flex h-11 shrink-0 items-center px-1 text-meta text-tertiary hover:text-primary md:h-9" onClick={onBack} aria-label="返回">
          ←<span className="hidden sm:inline">&nbsp;返回</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-primary">{task?.title ?? session.taskId}</p>
          <p className="truncate font-mono text-meta text-tertiary">
            {agentLabel} · {session.model === '' ? '默认模型' : session.model}
            {session.origin.kind === 'fork' ? ` · 分叉自 #${session.origin.atSeq}` : ''}
          </p>
        </div>
        <StatusPill status={status} reason={reason} lastSeq={live?.lastSeq ?? session.lastSeq} />
        <span className="flex shrink-0 items-center">
          <button
            className="flex h-11 items-center rounded-sm px-2 text-meta text-tertiary hover:text-primary md:h-9"
            onClick={() => setDetails(true)}
          >
            详情
          </button>
          <DisplayMenu settings={settings} onChange={changeSettings} />
          <Dropdown label="更多" icon="⋯">
            {(close) => (
              <>
                <MenuItem
                  title="从某一步分叉…"
                  hint={forkable ? '按事件序号开一条新会话，原会话不动' : '这条会话还没有内容'}
                  disabled={!forkable}
                  onClick={() => {
                    close();
                    startFork(lastSeq);
                  }}
                />
                <MenuItem
                  title="换个地方继续…"
                  hint={canContinueElsewhere(session) ? '换台机器或工作空间，带着对话摘要接着做' : CONTINUE_DISABLED_HINT}
                  disabled={!canContinueElsewhere(session)}
                  onClick={() => {
                    close();
                    setContinuing(true);
                  }}
                />
              </>
            )}
          </Dropdown>
        </span>
      </header>
      {details ? <SessionDetails canvas={canvas} session={session} artifacts={artifacts} live={live} onClose={() => setDetails(false)} /> : null}
      {forkAt !== null ? (
        <ForkDialog
          lastSeq={lastSeq}
          value={forkAt}
          onChange={setForkAt}
          busy={busy}
          error={forkError}
          onClose={() => setForkAt(null)}
          onFork={async () => {
            setBusy(true);
            setForkError(null);
            try {
              const created = await api.fork({ sessionId: session.id, atSeq: Number(forkAt), agentId: session.agentId, model: session.model });
              setForkAt(null);
              onChanged();
              onOpenSession(created.id);
            } catch (failure) {
              setForkError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
      {continuing ? (
        <ContinueDialog
          canvas={canvas}
          session={session}
          onClose={() => setContinuing(false)}
          onDone={(created) => {
            setContinuing(false);
            onChanged();
            onOpenSession(created.id);
          }}
        />
      ) : null}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div
          role="log"
          aria-label="对话记录"
          data-compact={settings.compact ? 'true' : undefined}
          className={`mx-auto flex max-w-[760px] flex-col ${settings.compact ? 'gap-2 px-3 py-3 text-[0.95em]' : 'gap-4 px-4 py-6'}`}
        >
          {blocks.length === 0 ? (
            <p className="text-meta text-tertiary">这条会话还没有说话。在下面写一句，交给 {agentLabel}。</p>
          ) : (
            blocks.map((block, index) => (
              <ChatBlock
                key={index}
                block={block}
                agentLabel={agentLabel}
                sessionId={session.id}
                settings={settings}
                last={index === blocks.length - 1}
                running={status === 'running' && (live?.awaiting ?? false)}
                onFork={forkable ? startFork : null}
              />
            ))
          )}
          {reason && blocks[blocks.length - 1]?.kind !== 'error' ? (
            <p role="alert" className="rounded-sm border-l-2 border-rust bg-rust/10 px-3 py-2 text-meta text-rust">{reason}</p>
          ) : null}
          {status === 'running' && (live?.awaiting ?? false) ? (
            <p className="text-meta text-tertiary" aria-live="polite">
              {agentLabel} 正在回复…
            </p>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-hair px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4">
        <div className="mx-auto max-w-[760px]">
          <Composer
            large
            session={{ ...session, status }}
            agentLabel={agentLabel}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={(text, attachments) =>
              run(async () => {
                await api.prompt(session.id, text, attachments);
                onDraftChange('');
              })
            }
            onInterrupt={() => void run(() => api.interrupt(session.id))}
            busy={busy}
            error={error}
            awaiting={live?.awaiting ?? false}
            onChangeOption={(optionId, value) => void run(() => onChangeOption(optionId, value))}
            capability={attachmentsCapability(agent?.capabilities)}
            commands={sessionCommands(session)}
            projectId={canvas.project.id}
          />
        </div>
      </div>
    </div>
  );
}
