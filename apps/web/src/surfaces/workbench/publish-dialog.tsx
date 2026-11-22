import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { delegationsApi, type DelegationDto } from '../../shell/api.ts';
import { useDelegationPublish } from '../../shell/delegations.ts';
import { delegationKeys } from '../../shell/query-keys.ts';
import {
  approvalStorageKey,
  chooseApprovalKey,
  DELEGATION_STATE_LABEL,
  isSha,
  publishGate,
  publishOutcomeLine,
  readApprovalMemory,
  shortSha
} from '../../atoms/delegation.ts';
import { DANGER_BUTTON, DialogShell, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../shell/dialog-shell.tsx';

function freshKey(): string {
  const value = String(globalThis.crypto?.randomUUID?.() ?? '');
  return value === '' ? `key-${Date.now().toString(36)}` : value;
}

function readStored(delegationId: string) {
  try {
    return readApprovalMemory(window.localStorage.getItem(approvalStorageKey(delegationId)));
  } catch {
    return null;
  }
}

function store(memory: { delegationId: string; headSha: string; approvalKey: string }) {
  try {
    window.localStorage.setItem(approvalStorageKey(memory.delegationId), JSON.stringify(memory));
  } catch {
    // 存不了就只在这次会话里稳：至少双击不会换键。
  }
}

/**
 * 人工发布面。
 *
 * 三件事必须看得见：要发的确切提交（完整 40 位）、这次确认是给哪条派工的、
 * 结果不明时只能对账。按钮上的每个请求都只带 `approvalKey` + `expectedHeadSha`，
 * 由服务端再核一次 HEAD，界面不自作主张推东西。
 */
export function DelegationPublishDialog({
  record,
  onClose,
  onPublished
}: {
  record: DelegationDto;
  onClose: () => void;
  onPublished: () => void;
}) {
  const client = useQueryClient();
  const { view, loading, error, reload } = useDelegationPublish(record.id);
  /**
   * 勾选是给**某一个确切提交**的背书，不是给这个对话框的。
   * 记的是勾选时看过的 SHA：HEAD 一变，勾选自动失效，要重新核对才能发布。
   */
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<'publish' | 'reconcile' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const gate = useMemo(() => (view === null ? null : publishGate(view)), [view]);
  const readySha = gate !== null && gate.kind === 'ready' ? gate.headSha : null;
  const checked = readySha !== null && checkedFor === readySha;
  const recheckNote =
    readySha !== null && checkedFor !== null && checkedFor !== readySha
      ? `要发布的提交已经换成 ${shortSha(readySha)}；你之前核对的是 ${shortSha(checkedFor)}。重新核对上面的完整值之后才能发布。`
      : null;
  const headSha = view?.headSha ?? null;
  const attempt = view?.attempt ?? null;
  const ambiguous = attempt !== null && (attempt.state === 'publishing' || attempt.state === 'uncertain');
  const published = attempt !== null && attempt.state === 'published';
  const stored = readStored(record.id);

  /** 这次的批准键：同提交复用（重试不换键），换提交才换新键。 */
  const approvalKey = (): string | null => {
    if (!isSha(headSha)) return null;
    const chosen = chooseApprovalKey(record.id, headSha, stored, freshKey);
    if (chosen.changed) store(chosen.memory);
    return chosen.memory.approvalKey;
  };

  const publish = async () => {
    if (gate === null || gate.kind !== 'ready') return;
    setBusy('publish');
    setFailure(null);
    const key = approvalKey();
    if (key === null) {
      setBusy(null);
      setFailure('拿不到这次要发布的提交');
      return;
    }
    try {
      await delegationsApi.publish(record.id, { approvalKey: key, expectedHeadSha: gate.headSha });
      onPublished();
      await client.invalidateQueries({ queryKey: delegationKeys.forCoordinator(record.coordinatorSessionId) });
      reload();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '发布失败');
      reload();
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    // 对账只读：不推送、不建 PR，用发起那次批准的同一个键去核对已发生的事实。
    if (stored === null) {
      setFailure('这个浏览器里没有这条派工的批准键：换台机器发起的批准，这里只能看结果');
      return;
    }
    setBusy('reconcile');
    setFailure(null);
    try {
      await delegationsApi.reconcile(record.id, { approvalKey: stored.approvalKey });
      await client.invalidateQueries({ queryKey: delegationKeys.forCoordinator(record.coordinatorSessionId) });
      reload();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : '对账失败');
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
        关闭
      </button>
      {ambiguous ? (
        <button
          type="button"
          className={stored === null ? SECONDARY_BUTTON : DANGER_BUTTON}
          disabled={busy !== null || stored === null}
          onClick={() => void reconcile()}
          data-testid="publish-reconcile"
        >
          {busy === 'reconcile' ? '正在对账…' : '只对账，不重发'}
        </button>
      ) : null}
      {!published && !ambiguous ? (
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy !== null || gate === null || gate.kind !== 'ready' || !checked}
          onClick={() => void publish()}
          data-testid="publish-go"
        >
          {busy === 'publish' ? '正在推送…' : '推送并开草稿 PR'}
        </button>
      ) : null}
    </div>
  );

  return (
    <DialogShell title="复核并发布" onClose={onClose} testId="delegation-publish" footer={footer}>
      {loading && view === null ? <p className="text-meta text-tertiary">正在读发布状态…</p> : null}
      {error !== null ? (
        <div className="space-y-2">
          <p role="alert" className="text-meta text-rust" data-testid="publish-error">
            {error}
          </p>
          <button type="button" className={SECONDARY_BUTTON} onClick={reload} data-testid="publish-retry">
            重新读取
          </button>
        </div>
      ) : null}

      {view !== null ? (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta">
            <dt className="text-tertiary">派工</dt>
            <dd className="break-all font-mono text-secondary" data-testid="publish-delegation">
              {view.delegationId}
            </dd>
            <dt className="text-tertiary">仓库</dt>
            <dd className="font-mono text-secondary" data-testid="publish-repo">
              {view.repo ?? '解析不出来'}
            </dd>
            <dt className="text-tertiary">分支</dt>
            <dd className="break-all font-mono text-secondary">
              {view.branch} → {view.baseBranch}
              {view.baseSha ? ` @ ${shortSha(view.baseSha)}` : ''}
            </dd>
            <dt className="text-tertiary">派工状态</dt>
            <dd className="text-secondary" data-testid="publish-state">
              {DELEGATION_STATE_LABEL[view.state]}
            </dd>
          </dl>

          <div className="rounded-control border border-hair px-2.5 py-2">
            <p className="text-meta text-tertiary">要发布的提交（工作区当前 HEAD）</p>
            {isSha(headSha) ? (
              <p className="mt-0.5 select-all break-all font-mono text-sub text-primary" data-testid="publish-head">
                {headSha}
              </p>
            ) : (
              <p className="mt-0.5 text-meta text-rust" data-testid="publish-head-missing">
                {view.headUnavailable?.trim() || '拿不到工作区当前提交'}
              </p>
            )}
            {gate !== null && gate.kind === 'blocked' ? (
              <p className="mt-1 text-meta text-secondary" data-testid="publish-blocked">
                {gate.reason}
              </p>
            ) : null}
          </div>

          <p className="text-meta text-secondary" data-testid="publish-outcome">
            {publishOutcomeLine(view)}
          </p>

          {attempt !== null && attempt.pullRequest !== null ? (
            <a
              href={attempt.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sub text-link underline decoration-dotted"
              data-testid="publish-pr"
              data-number={attempt.pullRequest.number}
            >
              草稿 PR #{attempt.pullRequest.number} · {attempt.pullRequest.repo}
            </a>
          ) : null}

          {gate !== null && gate.kind === 'ready' ? (
            <>
              {recheckNote !== null ? (
                <p role="status" className="text-meta text-rust" data-testid="publish-head-changed">
                  {recheckNote}
                </p>
              ) : null}
              <label className="flex items-start gap-2 text-meta text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={checked}
                  onChange={(event) => setCheckedFor(event.target.checked ? readySha : null)}
                  data-testid="publish-confirm"
                />
                <span>
                  我核对过提交 <code className="font-mono text-primary">{shortSha(gate.headSha)}</code>
                  （完整值见上），确认把它推送分支 {record.branch} 并创建草稿 PR。
                </span>
              </label>
            </>
          ) : null}

          {failure !== null ? (
            <p role="alert" className="rounded-control border border-rust/60 px-2.5 py-2 text-meta text-rust" data-testid="publish-failure">
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}
    </DialogShell>
  );
}
