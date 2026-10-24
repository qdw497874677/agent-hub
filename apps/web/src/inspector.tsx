import { useEffect, useState } from 'react';
import type { AgentDto, ArtifactDto, CanvasDto, JournalEntryDto, SessionDto } from './api.ts';
import { api } from './api.ts';

const CAPABILITY_LABEL: Record<string, string> = {
  prompt: '发消息',
  interrupt: '中断',
  fork: '分叉',
  resume: '恢复',
  tool_calls: '工具调用',
  artifacts: '产出物',
  structured_events: '结构化事件'
};

type CapabilityName = keyof AgentDto['capabilities'];

function CapabilityRow({ name, capability }: { name: CapabilityName; capability: AgentDto['capabilities'][CapabilityName] }) {
  const mark = capability.state === 'denied' ? '—' : '✓';
  const colour =
    capability.state === 'available' ? 'text-sage' : capability.state === 'limited' ? 'text-accent' : 'text-tertiary';
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-meta text-secondary">{CAPABILITY_LABEL[name] ?? name}</span>
      <span className="flex items-baseline gap-1.5 text-right">
        {capability.reason ? <span className="max-w-[150px] text-meta text-tertiary">{capability.reason}</span> : null}
        <span className={`font-mono text-meta ${colour}`}>{mark}</span>
      </span>
    </div>
  );
}

interface Props {
  readonly canvas: CanvasDto;
  readonly session: SessionDto;
  readonly artifacts: readonly ArtifactDto[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

export function Inspector({ canvas, session, artifacts, onClose, onChanged }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [journal, setJournal] = useState<readonly JournalEntryDto[]>([]);
  const [forkAt, setForkAt] = useState(String(session.lastSeq));

  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);

  useEffect(() => {
    setDraft('');
    setError(null);
    setForkAt(String(session.lastSeq));
  }, [session.id, session.lastSeq]);

  useEffect(() => {
    if (!showJournal) return;
    void api.events(session.id).then(setJournal);
  }, [showJournal, session.id, session.lastSeq]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-hair bg-panel">
      <header className="flex items-center justify-between border-b border-hair px-3 py-2">
        <div>
          <p className="text-head text-primary">{agent?.label ?? session.agentId}</p>
          <p className="font-mono text-meta text-tertiary">{session.model}</p>
        </div>
        <button className="text-meta text-tertiary hover:text-primary" onClick={onClose}>
          收起
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <section className="mb-3">
          <p className="mb-1 text-meta text-tertiary">属于任务</p>
          <p className="text-body text-secondary">{task?.title ?? session.taskId}</p>
        </section>

        <section className="mb-3">
          <p className="mb-1 text-meta text-tertiary">能力矩阵</p>
          {agent ? (
            (Object.keys(agent.capabilities) as CapabilityName[]).map((name) => (
              <CapabilityRow key={name} name={name} capability={agent.capabilities[name]} />
            ))
          ) : (
            <p className="text-meta text-tertiary">该 agent 当前没有在线节点</p>
          )}
        </section>

        {artifacts.length > 0 ? (
          <section className="mb-3">
            <p className="mb-1 text-meta text-tertiary">产出物</p>
            {artifacts.map((artifact) => (
              <p key={artifact.id} className="truncate font-mono text-meta text-secondary">
                ◆ {artifact.path}
              </p>
            ))}
          </section>
        ) : null}

        <section className="mb-3">
          <p className="mb-1 text-meta text-tertiary">分叉点</p>
          <div className="flex items-center gap-2">
            <input
              className="w-16 rounded-sm border border-hair bg-card px-2 py-1 font-mono text-meta text-primary"
              value={forkAt}
              onChange={(event) => setForkAt(event.target.value)}
            />
            <button
              className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-sage hover:text-sage disabled:opacity-40"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.fork({
                    sessionId: session.id,
                    atSeq: Number(forkAt),
                    agentId: session.agentId,
                    model: session.model
                  })
                )
              }
            >
              从这里分叉
            </button>
          </div>
        </section>

        <section>
          <button className="mb-1 text-meta text-tertiary hover:text-primary" onClick={() => setShowJournal(!showJournal)}>
            {showJournal ? '收起事件流' : '查看事件流'}
          </button>
          {showJournal ? (
            <div className="max-h-[220px] space-y-0.5 overflow-y-auto">
              {journal.map((entry) => (
                <p key={entry.seq} className="font-mono text-meta text-tertiary">
                  #{entry.seq} {entry.event.kind}
                </p>
              ))}
              {journal.length === 0 ? <p className="text-meta text-tertiary">没有记录</p> : null}
            </div>
          ) : null}
        </section>
      </div>

      <footer className="border-t border-hair px-3 py-2">
        {error ? <p className="mb-1 text-meta text-rust">{error}</p> : null}
        <textarea
          className="h-20 w-full resize-none rounded-sm border border-hair bg-card px-2 py-1.5 text-body text-primary outline-none focus:border-accent"
          placeholder="接着这条思路说下去…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="mt-2 flex items-center justify-between">
          <button
            className="rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-rust hover:text-rust disabled:opacity-40"
            disabled={busy || session.status !== 'running'}
            onClick={() => run(() => api.interrupt(session.id))}
          >
            中断
          </button>
          <button
            className="rounded-sm bg-accent px-3 py-1 text-meta text-canvas disabled:opacity-40"
            disabled={busy || draft.trim().length === 0}
            onClick={() =>
              run(async () => {
                await api.prompt(session.id, draft.trim());
                setDraft('');
              })
            }
          >
            发送
          </button>
        </div>
      </footer>
    </aside>
  );
}
