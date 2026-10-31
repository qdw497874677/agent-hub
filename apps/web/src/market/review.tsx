import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { marketApi, type FindingLineDto, type McpRiskSummaryDto, type SubmissionDetailDto } from '../api.ts';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../dialog-shell.tsx';
import { formatRoute } from '../route.ts';
import { INPUT, SMALL, DANGER, at, errorText, Section, Panel } from '../admin/shared.tsx';
import { CHANGE_TEXT } from '../admin/assets.tsx';
import { SCOPE_TEXT, STATUS_TEXT, KIND_TEXT } from './labels.ts';

/**
 * 审核页（#/assets/review/<提交>）：diff（逐行可评论）、静态扫描、MCP 风险摘要、密钥来源、投票与决定。
 * 作者不能批自己的；hub 管理员自批只在规则允许时出现，界面和审计都会标出来。
 */
const LEVEL_TEXT = { info: '提示', warn: '注意', high: '高风险' } as const;
const LEVEL_CLASS = { info: 'text-tertiary', warn: 'text-accent', high: 'text-rust' } as const;
const RISK_TEXT = { low: '低', medium: '中', high: '高' } as const;
const ORIGIN_TEXT = { user: '手动提交', git: 'Git 更新', token: '开放 API 令牌', migration: '迁移' } as const;
const SECRET_FROM = { personal: '个人', team: '团队', hub: 'hub', null: '缺失' } as const;

type Comment = SubmissionDetailDto['comments'][number];

export function ReviewPage({ submissionId }: { submissionId: string }) {
  const detail = useQuery({ queryKey: ['market', 'review', submissionId], queryFn: () => marketApi.review(submissionId) });
  if (detail.isLoading) return <p className="text-meta text-tertiary">载入…</p>;
  if (detail.error || !detail.data) return <p className="text-meta text-rust">{errorText(detail.error)}</p>;
  const d = detail.data;
  const s = d.submission;
  return (
    <div data-testid="review-page">
      <a className="text-meta text-tertiary hover:text-accent" href={formatRoute({ page: 'assets', tab: 'pending', reviewId: null })}>
        ← 待审
      </a>
      <div className="mb-3 mt-1 flex flex-wrap items-baseline gap-2">
        <h2 className="break-all font-mono text-head text-primary">{d.asset.name}</h2>
        <span className="text-meta text-tertiary">{KIND_TEXT[d.asset.kind as keyof typeof KIND_TEXT]}</span>
        <span className="text-meta text-tertiary">
          {SCOPE_TEXT[d.asset.scope]}
          {s.targetScope ? ` → 申请提升为${SCOPE_TEXT[s.targetScope]}` : ''}
        </span>
        <span data-testid="review-status" className="rounded-sm border border-hair px-1.5 text-meta text-primary">
          {STATUS_TEXT[s.status] ?? s.status}
        </span>
      </div>
      <p className="mb-1 text-meta text-secondary">
        {d.submitter} · {ORIGIN_TEXT[s.origin]} · {at(s.createdAt)} · 版本 <span className="font-mono">{s.digest.slice(0, 12)}</span> · 需 {d.needed} 人通过，已{' '}
        {s.approvals.length}
      </p>
      {s.previous && s.status === 'pending' ? <p className="mb-1 text-meta text-tertiary">已发布的旧版本在审核期间照常用，通过后才切换。</p> : null}
      {d.approvers.length ? (
        <p className="mb-1 text-meta text-secondary">
          通过人：
          {d.approvers.map((a, i) => (
            <span key={i} className="mr-2">
              {a.name}
              {a.selfApproved ? <span className="ml-1 text-rust">⚑ 自批</span> : null}
            </span>
          ))}
        </p>
      ) : null}
      {d.reviewers.length ? <p className="mb-3 text-meta text-tertiary">审核人：{d.reviewers.join('、')}</p> : null}
      {s.reason ? <p className="mb-3 rounded-sm border border-hair bg-card px-2.5 py-1.5 text-meta text-primary">理由：{s.reason}</p> : null}

      <Report detail={d} />
      <Decision detail={d} />
      <Changes detail={d} />
      <Section title="总体评论">
        <Panel>
          <div className="space-y-2 p-3">
            {d.comments.filter((c) => !c.path).map((c) => <CommentView key={c.id} comment={c} />)}
            <CommentBox submissionId={s.id} path={null} line={null} />
          </div>
        </Panel>
      </Section>
    </div>
  );
}

function Report({ detail }: { detail: SubmissionDetailDto }) {
  const { findings, mcp, secrets } = detail.submission.report;
  return (
    <Section title="扫描报告">
      <Panel>
        <div className="space-y-2 p-3 text-meta">
          {findings.length ? (
            <ul data-testid="findings" className="space-y-1">
              {findings.map((f, i) => (
                <li key={i} className="break-words">
                  <span className={LEVEL_CLASS[f.level]}>{LEVEL_TEXT[f.level]}</span>{' '}
                  <span className="font-mono text-tertiary">
                    {f.path}
                    {f.line ? `:${f.line}` : ''}
                  </span>{' '}
                  <span className="text-secondary">{f.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="findings" className="text-tertiary">没扫出问题。</p>
          )}
          {mcp ? <McpRisk risk={mcp} /> : null}
          {secrets.length ? (
            <p className="text-secondary">
              密钥来源：
              {secrets.map((x) => (
                <span key={x.name} className={`mr-2 font-mono ${x.from ? '' : 'text-rust'}`}>
                  {x.name}（{SECRET_FROM[String(x.from) as keyof typeof SECRET_FROM]}）
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </Panel>
    </Section>
  );
}

function McpRisk({ risk }: { risk: McpRiskSummaryDto }) {
  return (
    <div data-testid="mcp-risk" className={`rounded-sm border px-2.5 py-2 ${risk.level === 'high' ? 'border-rust' : 'border-hair'}`}>
      <p className="text-primary">
        MCP 风险：<span className={risk.level === 'high' ? 'text-rust' : risk.level === 'medium' ? 'text-accent' : 'text-tertiary'}>{RISK_TEXT[risk.level]}</span> ·{' '}
        {risk.transport === 'stdio' ? '在 Worker 上执行命令（stdio）' : '连远端 HTTP'}
      </p>
      {risk.command ? (
        <p className="break-all font-mono text-secondary">
          {risk.command} {risk.args.join(' ')}
        </p>
      ) : null}
      {risk.url ? <p className="break-all font-mono text-secondary">{risk.url}</p> : null}
      {risk.packages.length ? (
        <p className="text-secondary">
          包：
          {risk.packages.map((p) => (
            <span key={p.name} className={`mr-2 font-mono ${p.pinned ? '' : 'text-accent'}`}>
              {p.name}
              {p.pinned ? '' : '（未锁版本）'}
            </span>
          ))}
        </p>
      ) : null}
      {risk.secrets.length ? <p className="text-secondary">用到密钥：{risk.secrets.join('、')}</p> : null}
      {risk.changed.length ? <p className="text-accent">相比上一版变了：{risk.changed.join('、')}</p> : null}
      {risk.notes.map((n, i) => (
        <p key={i} className="text-tertiary">
          {n}
        </p>
      ))}
    </div>
  );
}

function useReviewAction<T>(run: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['market'] });
      void client.invalidateQueries({ queryKey: ['notifications'] });
    }
  });
}

function Decision({ detail }: { detail: SubmissionDetailDto }) {
  const s = detail.submission;
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const approve = useReviewAction((acknowledgeHigh: boolean) => marketApi.approve(s.id, acknowledgeHigh));
  const reject = useReviewAction((changes: boolean) => marketApi.reject(s.id, reason.trim(), changes));
  const withdraw = useReviewAction(() => marketApi.withdraw(s.id));
  if (s.status !== 'pending') return null;
  const high = s.report.findings.some((f: FindingLineDto) => f.level === 'high') || s.report.mcp?.level === 'high';
  const error = approve.error ?? reject.error ?? withdraw.error;
  return (
    <Section title="决定">
      <Panel>
        <div className="space-y-2 p-3 text-meta">
          {detail.approveBlocked && !detail.canApprove ? (
            <p data-testid="approve-blocked" className="text-tertiary">
              {detail.approveBlocked}
            </p>
          ) : null}
          {detail.canApprove ? (
            <div className="flex flex-wrap items-center gap-2">
              {high ? (
                <label className="flex items-center gap-1.5 text-secondary">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  我看过高风险项，仍然通过
                </label>
              ) : null}
              <button data-testid="review-approve" className={PRIMARY_BUTTON} disabled={approve.isPending || (high && !ack)} onClick={() => approve.mutate(ack)}>
                通过
              </button>
            </div>
          ) : null}
          {detail.canDecide ? (
            <div className="space-y-2">
              <textarea
                data-testid="review-reason"
                aria-label="驳回 / 要求修改的理由"
                className={INPUT}
                rows={2}
                placeholder="理由（作者会收到）"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <button data-testid="review-changes" className={SECONDARY_BUTTON} disabled={!reason.trim() || reject.isPending} onClick={() => reject.mutate(true)}>
                  要求修改
                </button>
                <button data-testid="review-reject" className={DANGER} disabled={!reason.trim() || reject.isPending} onClick={() => reject.mutate(false)}>
                  驳回
                </button>
              </div>
            </div>
          ) : null}
          {detail.canWithdraw ? (
            <button data-testid="review-withdraw" className={SMALL} disabled={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
              撤回这次提交
            </button>
          ) : null}
          {error ? <p className="text-rust">{errorText(error)}</p> : null}
        </div>
      </Panel>
    </Section>
  );
}

interface Line {
  readonly text: string;
  readonly kind: 'add' | 'del' | 'ctx' | 'hunk';
  readonly n: number | null;
}

/** 把 unified patch 拆成行，带新文件里的行号（删掉的行没有行号，不能评论）。 */
function patchLines(patch: string): Line[] {
  const out: Line[] = [];
  let n = 0;
  for (const text of patch.split('\n')) {
    if (/^(Index: |={10,}$|--- |\+\+\+ |\\ No newline)/.test(text)) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      n = Number(hunk[1]);
      out.push({ text, kind: 'hunk', n: null });
    } else if (text.startsWith('+')) out.push({ text, kind: 'add', n: n++ });
    else if (text.startsWith('-')) out.push({ text, kind: 'del', n: null });
    else if (text !== '' || out.length) out.push({ text, kind: 'ctx', n: n++ });
  }
  return out;
}

function Changes({ detail }: { detail: SubmissionDetailDto }) {
  const s = detail.submission;
  const diff = useQuery({ queryKey: ['market', 'review', s.id, 'diff'], queryFn: () => marketApi.reviewDiff(s.id) });
  if (diff.isLoading) return <p className="text-meta text-tertiary">载入差异…</p>;
  if (diff.error) return <p className="text-meta text-rust">{errorText(diff.error)}</p>;
  const files = diff.data?.files;
  return (
    <Section title="改动">
      <div className="space-y-2">
        {files
          ? files
              .filter((f) => f.change !== 'unchanged')
              .map((f) => (
                <FileBlock key={f.path} detail={detail} path={f.path} label={CHANGE_TEXT[f.change]}>
                  {f.patch ? <Lines detail={detail} path={f.path} lines={patchLines(f.patch)} /> : <p className="text-meta text-tertiary">二进制或过大，不显示内容</p>}
                </FileBlock>
              ))
          : (detail.revision?.files ?? []).map((f) => (
              <FileBlock key={f.path} detail={detail} path={f.path} label="新增">
                <NewFile detail={detail} path={f.path} />
              </FileBlock>
            ))}
      </div>
    </Section>
  );
}

function FileBlock({ detail, path, label, children }: { detail: SubmissionDetailDto; path: string; label: string; children: React.ReactNode }) {
  const inline = detail.submission.report.findings.filter((f) => f.path === path && !f.line);
  return (
    <details open className="rounded-sm border border-hair bg-card">
      <summary className="cursor-pointer px-2.5 py-1.5 text-sub text-primary">
        <span className="mr-2 text-meta text-tertiary">{label}</span>
        <span className="break-all font-mono">{path}</span>
      </summary>
      <div className="border-t border-hair py-1">
        {inline.map((f, i) => (
          <p key={i} className={`px-2.5 text-meta ${LEVEL_CLASS[f.level]}`}>
            {LEVEL_TEXT[f.level]}：{f.message}
          </p>
        ))}
        {children}
      </div>
    </details>
  );
}

function NewFile({ detail, path }: { detail: SubmissionDetailDto; path: string }) {
  const file = useQuery({ queryKey: ['market', 'review', detail.submission.id, 'file', path], queryFn: () => marketApi.reviewFile(detail.submission.id, path) });
  if (file.isLoading) return <p className="px-2.5 text-meta text-tertiary">载入…</p>;
  if (file.error) return <p className="px-2.5 text-meta text-tertiary">{errorText(file.error)}</p>;
  const text = (file.data?.text ?? '').replace(/\n$/, '');
  return <Lines detail={detail} path={path} lines={text.split('\n').map((t, i) => ({ text: `+${t}`, kind: 'add' as const, n: i + 1 }))} />;
}

function Lines({ detail, path, lines }: { detail: SubmissionDetailDto; path: string; lines: Line[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.45]">
      {lines.map((l, i) => {
        const comments = l.n === null ? [] : detail.comments.filter((c) => c.path === path && c.line === l.n);
        const findings = l.n === null ? [] : detail.submission.report.findings.filter((f) => f.path === path && f.line === l.n);
        return (
          <div key={i}>
            <div
              className={`group flex ${
                l.kind === 'add' ? 'bg-sage/15 text-primary' : l.kind === 'del' ? 'bg-rust/20 text-secondary' : l.kind === 'hunk' ? 'text-accent-dim' : 'text-tertiary'
              }`}
            >
              <span className="w-9 shrink-0 select-none pr-1 text-right text-tertiary">{l.n ?? ''}</span>
              {l.n !== null ? (
                <button
                  data-testid={`line-${path}-${l.n}`}
                  aria-label={`评论第 ${l.n} 行`}
                  className="w-5 shrink-0 text-tertiary opacity-40 hover:text-accent group-hover:opacity-100"
                  onClick={() => setOpen(open === l.n ? null : l.n)}
                >
                  +
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <span className="whitespace-pre pr-2">{l.text || ' '}</span>
            </div>
            {findings.map((f, k) => (
              <p key={k} className={`ml-14 whitespace-normal font-sans text-meta ${LEVEL_CLASS[f.level]}`}>
                {LEVEL_TEXT[f.level]}：{f.message}
              </p>
            ))}
            {comments.length || open === l.n ? (
              <div className="mx-2 my-1 space-y-1 whitespace-normal rounded-sm border border-hair bg-panel p-2 font-sans sm:ml-14">
                {comments.map((c) => <CommentView key={c.id} comment={c} />)}
                {open === l.n ? <CommentBox submissionId={detail.submission.id} path={path} line={l.n} onDone={() => setOpen(null)} /> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CommentView({ comment }: { comment: Comment }) {
  return (
    <div className="text-meta">
      <span className="text-primary">{comment.author}</span> <span className="text-tertiary">{at(comment.at)}</span>
      <p className="whitespace-pre-wrap break-words text-secondary">{comment.body}</p>
    </div>
  );
}

function CommentBox({ submissionId, path, line, onDone }: { submissionId: string; path: string | null; line: number | null; onDone?: () => void }) {
  const [body, setBody] = useState('');
  const send = useReviewAction(() => marketApi.comment(submissionId, { path, line, body: body.trim() }));
  return (
    <div className="space-y-1.5">
      <textarea data-testid="comment-body" aria-label="评论" className={INPUT} rows={2} placeholder="写评论…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-2">
        <button
          data-testid="comment-send"
          className={SMALL}
          disabled={!body.trim() || send.isPending}
          onClick={() =>
            send.mutate(undefined, {
              onSuccess: () => {
                setBody('');
                onDone?.();
              }
            })
          }
        >
          发评论
        </button>
        {send.error ? <span className="text-meta text-rust">{errorText(send.error)}</span> : null}
      </div>
    </div>
  );
}
