import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { previewsApi, type PreviewLinkDto } from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';
import { SMALL_BUTTON } from '../shell/dialog-shell.tsx';
import { PREVIEW_LABEL_LIMIT, previewAge, previewDraftProblem, previewStateLine, previewUrlFor, sortPreviews } from './preview-links.ts';

/**
 * 会话页的「预览」页签（docs/design/preview.md §3 / §10）。
 *
 * 只做一件事：把 worker 上一个回环端口登记成 hub 上的一条链接，然后给「打开 / 复制」。
 * 路径与 HMR 由 hub 的端口映射负责，这里不拼任何路径前缀——拼错就白屏。
 */

const INPUT =
  'w-full min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 text-meta text-primary outline-none placeholder:text-tertiary focus:border-accent';
/** 手机上按钮至少要 32px 高，手指才点得准。 */
const BUTTON = `${SMALL_BUTTON} inline-flex min-h-8 items-center justify-center`;

const message = (error: unknown): string | null =>
  error instanceof Error ? error.message : error ? '网络出错了，再试一次' : null;

interface Props {
  readonly sessionId: string;
  /** 页签是否在前台：切到预览才拉列表，别让后台页签白白发请求。 */
  readonly active: boolean;
}

export function PreviewPanel({ sessionId, active }: Props) {
  const queryClient = useQueryClient();
  const key = sessionKeys.previews(sessionId);
  const links = useQuery({ queryKey: key, queryFn: () => previewsApi.list(sessionId), enabled: active, retry: false });

  const [port, setPort] = useState('');
  const [label, setLabel] = useState('');
  const [attempted, setAttempted] = useState(false);
  /** 就地二次确认：点一次「移除」变成「确认移除」，避免手滑删掉正在用的链接。 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 复制失败时把链接摊在输入框里让人手动选中（手机浏览器常直接不给 clipboard）。 */
  const [fallbackId, setFallbackId] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLInputElement | null>(null);
  /** 「N 分钟前」要往前走：页签在前台时每 30 秒重算一次。 */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (fallbackId === null) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallbackId]);

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [active]);

  // 换会话：别把上一条会话的表单、确认态、复制结果带过去
  useEffect(() => {
    setPort('');
    setLabel('');
    setAttempted(false);
    setConfirmId(null);
    setCopiedId(null);
    setFallbackId(null);
  }, [sessionId]);

  const create = useMutation({
    mutationFn: (body: { port: number; label?: string }) => previewsApi.create(sessionId, body),
    onSuccess: (link) => {
      queryClient.setQueryData<PreviewLinkDto[]>(key, (current) => sortPreviews([...(current ?? []), link]));
      setPort('');
      setLabel('');
      setAttempted(false);
      void queryClient.invalidateQueries({ queryKey: key });
    }
  });

  const remove = useMutation({
    mutationFn: (linkId: string) => previewsApi.remove(sessionId, linkId),
    onSuccess: (_result, linkId) => {
      setConfirmId(null);
      queryClient.setQueryData<PreviewLinkDto[]>(key, (current) => (current ?? []).filter((item) => item.id !== linkId));
      void queryClient.invalidateQueries({ queryKey: key });
    }
  });

  const rows = sortPreviews(links.data ?? []);
  const draftProblem = previewDraftProblem({ port, label });
  // 还没输入就不红字（打开页签先看到一片红很吓人）；一开始打字就即时校验。
  const visibleProblem = attempted || port.trim() !== '' ? draftProblem : null;
  const error =
    message(create.error) ??
    message(remove.error) ??
    visibleProblem ??
    (links.isError ? message(links.error) ?? '读不到预览链接' : null);
  const busy = create.isPending;

  const submit = () => {
    setAttempted(true);
    if (draftProblem !== null || busy) return;
    create.reset();
    create.mutate({ port: Number(port.trim()), ...(label.trim() === '' ? {} : { label: label.trim() }) });
  };

  const open = (link: PreviewLinkDto) => {
    window.open(previewUrlFor(window.location, link.hubPort), '_blank', 'noopener');
  };

  const copy = async (link: PreviewLinkDto) => {
    const url = previewUrlFor(window.location, link.hubPort);
    setCopiedId(null);
    try {
      const write = navigator.clipboard?.writeText;
      if (!write) throw new Error('no clipboard');
      await write.call(navigator.clipboard, url);
      setFallbackId(null);
      setCopiedId(link.id);
    } catch {
      setFallbackId(link.id);
    }
  };

  return (
    <div data-testid="preview-panel" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5 md:px-4">
      <p data-testid="preview-note" className="text-meta text-tertiary">
        这些链接对登录这台 hub 的人可见
      </p>

      {links.isPending ? <p className="mt-2 text-meta text-tertiary">加载中…</p> : null}

      {!links.isPending && rows.length === 0 && !links.isError ? (
        <p data-testid="preview-empty" className="mt-2 text-meta text-secondary">
          在终端里 <code className="rounded-sm bg-card px-1 font-mono text-[11px]">npm run dev</code> 起来之后，把端口填进来就行
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-2 flex min-w-0 flex-col gap-1.5">
          {rows.map((link) => {
            const url = previewUrlFor(window.location, link.hubPort);
            const offline = link.state === 'offline';
            const confirmed = confirmId === link.id;
            return (
              <li key={link.id} data-testid="preview-row" className="min-w-0 rounded-sm border border-hair px-2 py-1.5">
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <span className="min-w-0 break-words text-primary">{link.label || '预览'}</span>
                  <span className="font-mono text-[11px] text-tertiary">端口 {link.port}</span>
                </p>
                <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-meta">
                  <span className={offline ? 'text-rust' : link.state === 'ready' ? 'text-sage' : 'text-tertiary'}>
                    {previewStateLine(link)}
                  </span>
                  <span className="text-tertiary">{previewAge(now, link.lastSeenAt)}</span>
                </p>

                {offline ? (
                  <p className="mt-0.5 text-[11px] text-tertiary">机器离线的时候链接打不开，等它回来再试。</p>
                ) : null}

                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  <button
                    data-testid="preview-open"
                    className={BUTTON}
                    disabled={offline}
                    title={offline ? '机器离线，链接现在打不开' : `在新标签打开 ${url}`}
                    onClick={() => open(link)}
                  >
                    打开
                  </button>
                  <button
                    data-testid="preview-copy"
                    className={BUTTON}
                    disabled={offline}
                    title={offline ? '机器离线，链接现在打不开' : '复制链接'}
                    onClick={() => void copy(link)}
                  >
                    {copiedId === link.id ? '已复制' : '复制'}
                  </button>
                  <button
                    data-testid="preview-remove"
                    className={`${BUTTON} ml-auto ${confirmed ? 'border-rust text-rust' : ''}`}
                    disabled={remove.isPending}
                    onBlur={() => {
                      // 点到别处就当放弃这次确认（正在删的时候别把标签翻回去）
                      if (!remove.isPending && confirmed) setConfirmId(null);
                    }}
                    onClick={() => {
                      remove.reset();
                      if (!confirmed) {
                        setConfirmId(link.id);
                        return;
                      }
                      remove.mutate(link.id);
                    }}
                  >
                    {confirmed ? '确认移除' : '移除'}
                  </button>
                </div>

                {fallbackId === link.id ? (
                  <input
                    ref={fallbackRef}
                    data-testid="preview-url"
                    className={`${INPUT} mt-1.5 font-mono text-[11px]`}
                    readOnly
                    value={url}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="预览链接"
                  />
                ) : null}
                {fallbackId === link.id ? (
                  <p className="mt-1 text-[11px] text-tertiary">复制失败，链接已选中，按 Ctrl+C / ⌘C 复制。</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-2.5 flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-col gap-0.5 sm:w-24">
          <span className="text-[11px] text-tertiary">端口</span>
          <input
            data-testid="preview-port"
            className={INPUT}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={5}
            placeholder="5173"
            value={port}
            onChange={(event) => {
              create.reset();
              setPort(event.target.value);
            }}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[11px] text-tertiary">标签（可选）</span>
          <input
            data-testid="preview-label"
            className={INPUT}
            autoComplete="off"
            placeholder="Vite / API"
            maxLength={PREVIEW_LABEL_LIMIT + 20}
            value={label}
            onChange={(event) => {
              create.reset();
              setLabel(event.target.value);
            }}
          />
        </label>
        <button data-testid="preview-create" className={BUTTON} disabled={busy} onClick={submit}>
          {busy ? '暴露中…' : '暴露端口'}
        </button>
      </div>

      {error ? (
        <p role="alert" data-testid="preview-error" className="mt-1.5 break-words text-meta text-rust">
          {error}
        </p>
      ) : null}
    </div>
  );
}
