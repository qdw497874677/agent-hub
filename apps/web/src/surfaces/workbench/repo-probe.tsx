import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { WorkerInfoDto } from '../../shell/api.ts';
import { WorkerPicker } from '../../shell/workers.tsx';
import {
  repoDiagnosticFrom,
  repoDiagnosticRows,
  repoDiagnosticText,
  repoProbeText,
  type ProjectRepoValue,
  type RepoCheckResult,
  type RepoCheckCredentialSource,
  type ReposCheck
} from './project-repos.ts';

/**
 * 每行仓库的「检查是否有效」状态（新建项目和项目设置共用）。
 *
 * 检查是只读的：只把这一行的地址 / 分支 / 令牌发给后端，在选中的机器上试读一下，
 * 不保存项目、不创建、不 clone。结论只对发出去的那一刻有效——地址、分支、令牌或
 * 机器一变，旧结论立刻隐藏；请求还在路上时也一样，晚到的响应会被丢掉。
 */
export type RepoProbe =
  | { readonly state: 'checking' }
  | { readonly state: 'done'; readonly check: ReposCheck; readonly result: RepoCheckResult | null }
  | { readonly state: 'failed'; readonly message: string };

export interface RepoProbes {
  get(index: number): RepoProbe | undefined;
  check(index: number, repo: ProjectRepoValue, workerId: string | null): void;
  /** 整份检查（保存前的自动检查）也铺到每行，别出现两套互相矛盾的结论。 */
  apply(check: ReposCheck): void;
  invalidate(index: number): void;
  clear(): void;
}

export function useRepoProbes(
  request: (repo: ProjectRepoValue, workerId: string | null) => Promise<ReposCheck>
): RepoProbes {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [entries, setEntries] = useState<Readonly<Record<number, RepoProbe>>>({});
  // epoch 管「全部作废」（换机器 / 保存成功）；revision 管单行作废。
  const epoch = useRef(0);
  const revision = useRef<Record<number, number>>({});
  const runSeq = useRef(0);
  const runs = useRef<Record<number, number>>({});
  const checking = useRef(new Set<number>());

  const clear = useCallback(() => {
    epoch.current += 1;
    revision.current = {};
    runs.current = {};
    checking.current.clear();
    setEntries({});
  }, []);

  const invalidate = useCallback((index: number) => {
    revision.current[index] = (revision.current[index] ?? 0) + 1;
    checking.current.delete(index);
    setEntries((current) => {
      if (!(index in current)) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
  }, []);

  const apply = useCallback((check: ReposCheck) => {
    // 整份结果比单行请求更新：作废还在路上的单行检查，免得旧响应覆盖刚铺好的结论。
    epoch.current += 1;
    runs.current = {};
    checking.current.clear();
    const next: Record<number, RepoProbe> = {};
    check.results.forEach((result, index) => {
      next[index] = { state: 'done', check, result };
    });
    setEntries(next);
  }, []);

  const check = useCallback((index: number, repo: ProjectRepoValue, workerId: string | null) => {
    // 同一行已经在查：按钮此时是禁用的，这里再兜一层，防止重复请求。
    if (checking.current.has(index)) return;
    checking.current.add(index);
    const round = ++runSeq.current;
    runs.current[index] = round;
    const atEpoch = epoch.current;
    const atRevision = revision.current[index] ?? 0;
    setEntries((current) => ({ ...current, [index]: { state: 'checking' } }));

    void (async () => {
      try {
        const result = await requestRef.current(repo, workerId);
        if (epoch.current !== atEpoch || runs.current[index] !== round || (revision.current[index] ?? 0) !== atRevision) return;
        setEntries((current) => ({
          ...current,
          [index]: { state: 'done', check: result, result: result.results[0] ?? null }
        }));
      } catch (error) {
        if (epoch.current !== atEpoch || runs.current[index] !== round || (revision.current[index] ?? 0) !== atRevision) return;
        setEntries((current) => ({
          ...current,
          [index]: {
            state: 'failed',
            message: error instanceof Error && error.message.trim() !== '' ? error.message : '检查没成功，请稍后再试'
          }
        }));
      } finally {
        if (runs.current[index] === round) checking.current.delete(index);
      }
    })();
  }, []);

  const get = useCallback((index: number) => entries[index], [entries]);

  return { get, check, apply, invalidate, clear };
}

/**
 * 失败时的受控诊断：默认收起，只占一小行「查看诊断」。
 *
 * 后端只给阶段 / 代码 / 传输 / 耗时这类结构化字段，所以这里也只显示这些 ——
 * 不复制地址、令牌、后端原话或 stderr。能展开、能复制，窄屏上也不会撑宽卡片。
 */
function RepoProbeDiagnostic({
  result,
  workerLabel,
  fallbackSource,
  testId
}: {
  result: RepoCheckResult;
  workerLabel: string | null;
  fallbackSource: RepoCheckCredentialSource | null;
  testId: string;
}) {
  const diagnostic = repoDiagnosticFrom(result.diagnostic);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // 剪贴板写不进去（普通 HTTP 下 navigator.clipboard 直接没有，或权限被拒）时
  // 不装作复制成功：展开一段只读文本让用户自己选。每次失败 +1，重新聚焦并全选。
  const [manualCopies, setManualCopies] = useState(0);
  const manualRef = useRef<HTMLTextAreaElement | null>(null);
  const panelId = useId();
  const manualId = useId();
  useEffect(() => {
    if (manualCopies === 0) return;
    const field = manualRef.current;
    if (field === null) return;
    field.focus();
    field.select();
  }, [manualCopies]);
  if (diagnostic === null) return null;
  const context = {
    workerLabel,
    credentialSource: result.credentialSource ?? fallbackSource
  };
  const rows = repoDiagnosticRows(diagnostic, context);
  const diagnosisText = repoDiagnosticText(diagnostic, context);
  const copy = () => {
    setCopied(false);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      setManualCopies((count) => count + 1);
      return;
    }
    const failed = () => setManualCopies((count) => count + 1);
    try {
      void clipboard.writeText(diagnosisText).then(() => {
        setManualCopies(0);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }, failed);
    } catch {
      failed();
    }
  };
  return (
    <div className="mt-1" data-testid={`${testId}-diagnostic`}>
      <button
        type="button"
        className="flex min-h-[44px] items-center gap-1 text-meta text-tertiary hover:text-primary md:min-h-0"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="查看这次仓库检查的诊断详情"
        title="展开看阶段、原因和耗时；不含地址与令牌"
        data-testid={`${testId}-diagnostic-toggle`}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        查看诊断
      </button>
      {open ? (
        <div id={panelId} className="mt-0.5 rounded-sm border border-hair bg-panel px-2 py-1.5">
          <dl
            className="grid grid-cols-[5em_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-meta text-secondary"
            data-testid={`${testId}-diagnostic-details`}
          >
            {rows.map((row) => (
              <Fragment key={row.label}>
                <dt className="text-tertiary">{row.label}</dt>
                <dd className={`min-w-0 break-words ${row.mono === true ? 'font-mono' : ''}`}>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
          <button
            type="button"
            className="mt-1 inline-flex min-h-[44px] items-center text-meta text-tertiary hover:text-primary md:min-h-0"
            aria-label="复制诊断信息"
            data-testid={`${testId}-diagnostic-copy`}
            onClick={copy}
          >
            {copied ? '已复制' : '复制诊断'}
          </button>
          {manualCopies > 0 ? (
            <div className="mt-0.5" data-testid={`${testId}-diagnostic-manual`}>
              <label htmlFor={manualId} className="block text-meta text-tertiary">
                没法写入剪贴板，下面是同一段诊断；已选中，可直接复制
              </label>
              <textarea
                id={manualId}
                ref={manualRef}
                readOnly
                rows={Math.min(Math.max(diagnosisText.split('\n').length, 3), 8)}
                value={diagnosisText}
                spellCheck={false}
                className="mt-0.5 w-full resize-none rounded-sm border border-hair bg-card px-2 py-1 font-mono text-[11px] leading-4 text-primary"
                data-testid={`${testId}-diagnostic-manual-text`}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 单行检查的结论 / 进度。没有结论时不占位。 */
export function RepoProbeStatus({ probe, testId }: { probe: RepoProbe | undefined; testId: string }) {
  if (probe === undefined) return null;
  if (probe.state === 'checking') {
    return (
      <p className="mt-1 text-meta text-tertiary" role="status" aria-live="polite" data-testid={testId} data-state="checking">
        正在读取仓库…
      </p>
    );
  }
  if (probe.state === 'failed') {
    return (
      <p className="mt-1 break-words text-meta text-rust" role="status" aria-live="polite" data-testid={testId} data-state="failed">
        {probe.message}
      </p>
    );
  }
  if (probe.result === null) {
    const text = probe.check.unavailable?.trim();
    return (
      <p className="mt-1 break-words text-meta text-tertiary" role="status" aria-live="polite" data-testid={testId} data-state="unavailable">
        {text === undefined || text === '' ? '这次检查没有返回结论。' : text}
      </p>
    );
  }
  return (
    <>
      <p
        className={`mt-1 break-words text-meta ${probe.result.ok ? 'text-sage' : 'text-rust'}`}
        role="status"
        aria-live="polite"
        data-testid={testId}
        data-state={probe.result.ok ? 'ok' : 'failed'}
      >
        {repoProbeText(probe.result, probe.check.workerLabel, probe.check.credentialSource ?? null)}
      </p>
      {probe.result.ok ? null : (
        <RepoProbeDiagnostic
          result={probe.result}
          workerLabel={probe.check.workerLabel}
          fallbackSource={probe.check.credentialSource ?? null}
          testId={testId}
        />
      )}
    </>
  );
}

export function RepoProbeHint() {
  return (
    <p className="text-meta text-tertiary" data-testid="repo-probe-hint">
      检查只读：在选中的机器上试读，不会保存、创建或下载仓库。公开仓库不校验令牌，能读不代表令牌被接受。
    </p>
  );
}

/** 检查用哪台机器；只有一台时 WorkerPicker 自己不渲染。 */
export function RepoProbeMachine({
  workers,
  value,
  onChange
}: {
  workers: readonly WorkerInfoDto[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return <WorkerPicker workers={workers} value={value} onChange={onChange} allowAuto label="在哪台机器上检查" />;
}
