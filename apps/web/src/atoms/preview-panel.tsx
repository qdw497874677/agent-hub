import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { previewsApi, type PreviewLinkDto } from '../shell/api.ts';
import { sessionKeys } from '../shell/query-keys.ts';
import { SMALL_BUTTON } from '../shell/dialog-shell.tsx';
import {
  PREVIEW_LABEL_LIMIT,
  previewAge,
  previewDraftProblem,
  previewStateLine,
  previewUrlFor,
  shareActive,
  shareHoursLabel,
  shareHoursOptions,
  shareStateText,
  sortPreviews
} from './preview-links.ts';

/**
 * 会话页的「预览」页签（docs/design/preview.md §3 / §10）。
 *
 * 只做一件事：把 worker 上一个回环端口登记成 hub 上的一条链接，然后给「打开 / 复制 / 分享」。
 * 路径与 HMR 由 hub 的端口映射负责，这里不拼任何路径前缀——拼错就白屏。
 */

const INPUT =
  'w-full min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5 text-meta text-primary outline-none placeholder:text-tertiary focus:border-accent';
/** 手机上按钮至少要 32px 高，手指才点得准。 */
const BUTTON = `${SMALL_BUTTON} inline-flex min-h-8 items-center justify-center`;
/** 行上的小标签（「自动发现」/「公开」）：高度和按钮对齐，不抢视线。 */
const TAG = 'inline-flex shrink-0 items-center rounded-sm border px-1 text-[10px] leading-4';

const message = (error: unknown): string | null =>
  error instanceof Error ? error.message : error ? '网络出错了，再试一次' : null;

interface Props {
  readonly sessionId: string;
  /** 页签是否在前台：切到预览才拉列表，别让后台页签白白发请求。 */
  readonly active: boolean;
  /** 项目约定的默认端口（项目设置里填的），只用来预填输入框。 */
  readonly defaultPort?: number | null;
}

export function PreviewPanel({ sessionId, active, defaultPort = null }: Props) {
  const queryClient = useQueryClient();
  const key = sessionKeys.previews(sessionId);
  const links = useQuery({ queryKey: key, queryFn: () => previewsApi.list(sessionId), enabled: active, retry: false });

  const [port, setPort] = useState(defaultPort === null ? '' : String(defaultPort));
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

  /** 展开着分享面板的那一行；同一时刻只开一条，避免几块面板一起抢注意力。 */
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareHours, setShareHours] = useState(24);
  /** 刚签出来的公开链接。令牌只在这一次响应里出现，翻页 / 刷新就没了，所以要留在本地。 */
  const [shareLink, setShareLink] = useState<{ linkId: string; url: string; expiresAt: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareFallback, setShareFallback] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  /** 收起面板时把焦点还回触发按钮，键盘用户不会掉到页面开头。 */
  const shareTriggers = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    if (fallbackId === null) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallbackId]);

  useEffect(() => {
    if (!shareLink) return;
    shareInputRef.current?.focus();
    shareInputRef.current?.select();
  }, [shareLink]);

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
    setShareId(null);
    setShareLink(null);
    setShareCopied(false);
    setShareFallback(false);
    setRevokeId(null);
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

  const share = useMutation({
    mutationFn: (input: { linkId: string; hours: number }) => previewsApi.share(sessionId, input.linkId, input.hours),
    onSuccess: (result, input) => {
      setShareLink({ linkId: input.linkId, url: result.url, expiresAt: result.expiresAt });
      setShareCopied(false);
      setShareFallback(false);
      // 先把行标成已分享（列表马上跟着变），再拉一次拿后端算准的到期时间。
      queryClient.setQueryData<PreviewLinkDto[]>(key, (current) =>
        (current ?? []).map((item) =>
          item.id === input.linkId ? { ...item, shared: true, shareExpiresAt: result.expiresAt } : item
        )
      );
      void queryClient.invalidateQueries({ queryKey: key });
    }
  });

  const unshare = useMutation({
    mutationFn: (linkId: string) => previewsApi.unshare(sessionId, linkId),
    onSuccess: (_result, linkId) => {
      setRevokeId(null);
      setShareLink((current) => (current?.linkId === linkId ? null : current));
      queryClient.setQueryData<PreviewLinkDto[]>(key, (current) =>
        (current ?? []).map((item) => (item.id === linkId ? { ...item, shared: false, shareExpiresAt: null } : item))
      );
      void queryClient.invalidateQueries({ queryKey: key });
      // 撤销完就把面板收起来：行上的「公开」标签已经消失，还留着表单反而像没生效。
      if (shareId === linkId) {
        setShareId(null);
        shareTriggers.current.get(linkId)?.focus();
      }
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

  const copyShare = async (url: string) => {
    setShareCopied(false);
    try {
      const write = navigator.clipboard?.writeText;
      if (!write) throw new Error('no clipboard');
      await write.call(navigator.clipboard, url);
      setShareFallback(false);
      setShareCopied(true);
    } catch {
      // 复制不了就把输入框里的链接选中，至少能手动复制（iOS 有时就是不给你 clipboard）。
      setShareFallback(true);
      shareInputRef.current?.focus();
      shareInputRef.current?.select();
    }
  };

  const closeShare = (linkId: string) => {
    setShareId(null);
    setRevokeId(null);
    setShareFallback(false);
    setShareCopied(false);
    shareTriggers.current.get(linkId)?.focus();
  };

  const toggleShare = (link: PreviewLinkDto) => {
    share.reset();
    unshare.reset();
    setRevokeId(null);
    setShareCopied(false);
    setShareFallback(false);
    if (shareId === link.id) {
      closeShare(link.id);
      return;
    }
    setShareId(link.id);
    setShareHours(24);
    // 只有换行才丢掉本地那条 url：同一行重新展开时它还是有效的。
    if (shareLink?.linkId !== link.id) setShareLink(null);
  };

  // Esc 收起分享面板，并把焦点还给触发它的按钮。
  useEffect(() => {
    if (shareId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = shareId;
      setShareId(null);
      setRevokeId(null);
      shareTriggers.current.get(target)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shareId]);

  return (
    <div data-testid="preview-panel" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5 md:px-4">
      <p data-testid="preview-note" className="text-meta text-tertiary">
        这些链接对登录这台 hub 的人可见；分享出去的链接不用登录，到期自动失效
      </p>

      {links.isPending ? <p className="mt-2 text-meta text-tertiary">加载中…</p> : null}

      {!links.isPending && rows.length === 0 && !links.isError ? (
        <p data-testid="preview-empty" className="mt-2 text-meta text-secondary">
          在终端里 <code className="rounded-sm bg-card px-1 font-mono text-[11px]">npm run dev</code>{' '}
          起来之后，端口会自动出现在这里；也可以手动填下面
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-2 flex min-w-0 flex-col gap-1.5">
          {rows.map((link) => {
            const url = previewUrlFor(window.location, link.hubPort);
            const offline = link.state === 'offline';
            const confirmed = confirmId === link.id;
            const sharing = shareId === link.id;
            const shareUrl = shareLink?.linkId === link.id ? shareLink.url : null;
            const activeShare = shareActive(link, now);
            const shareState = shareStateText(link, now);
            const shareError = sharing ? message(share.error) ?? message(unshare.error) : null;
            return (
              <li key={link.id} data-testid="preview-row" className="min-w-0 rounded-sm border border-hair px-2 py-1.5">
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <span className="min-w-0 break-words text-primary">{link.label || '预览'}</span>
                  {link.source === 'detected' ? (
                    <span
                      data-testid="preview-detected"
                      title="从终端输出里认出来的端口"
                      className={`${TAG} border-hair text-tertiary`}
                    >
                      自动发现
                    </span>
                  ) : null}
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
                  {link.shared ? (
                    <span
                      data-testid="preview-shared"
                      title={shareState ?? '已生成公开链接'}
                      className={`${TAG} ${activeShare ? 'border-accent/60 text-accent' : 'border-hair text-tertiary'}`}
                    >
                      {activeShare ? '公开' : '公开 · 已过期'}
                    </span>
                  ) : null}
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
                    data-testid="preview-share"
                    ref={(node) => {
                      shareTriggers.current.set(link.id, node);
                    }}
                    className={BUTTON}
                    aria-expanded={sharing}
                    aria-label={link.shared ? '分享（管理公开链接）' : '分享（生成公开链接）'}
                    disabled={offline && !link.shared}
                    title={offline && !link.shared ? '机器离线，等它回来再分享' : '生成一条不用登录就能打开的链接'}
                    onClick={() => toggleShare(link)}
                  >
                    分享…
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

                {sharing ? (
                  <div
                    data-testid="preview-share-panel"
                    className="mt-1.5 min-w-0 rounded-sm border border-hair bg-card px-2 py-1.5"
                  >
                    {link.shared ? (
                      <>
                        {shareUrl === null ? (
                          <p className="text-[11px] text-tertiary">
                            令牌只在生成时显示一次。撤销后重新分享，可以再拿一条新链接。
                          </p>
                        ) : (
                          <input
                            ref={shareInputRef}
                            data-testid="preview-share-url"
                            className={`${INPUT} font-mono text-[11px]`}
                            readOnly
                            value={shareUrl}
                            onFocus={(event) => event.currentTarget.select()}
                            aria-label="公开分享链接"
                          />
                        )}
                        {shareFallback ? (
                          <p className="mt-1 text-[11px] text-tertiary">复制失败，链接已选中，按 Ctrl+C / ⌘C 复制。</p>
                        ) : null}
                        <p
                          data-testid="preview-share-state"
                          className={`mt-1 text-meta ${activeShare ? 'text-sage' : 'text-rust'}`}
                        >
                          {shareState ?? '公开分享'}
                        </p>
                        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                          {shareUrl === null ? null : (
                            <button
                              data-testid="preview-share-copy"
                              className={BUTTON}
                              aria-label="复制公开分享链接"
                              onClick={() => void copyShare(shareUrl)}
                            >
                              {shareCopied ? '已复制' : '复制'}
                            </button>
                          )}
                          <button
                            data-testid="preview-share-revoke"
                            className={`${BUTTON} ${revokeId === link.id ? 'border-rust text-rust' : ''}`}
                            aria-label={revokeId === link.id ? '确认撤销公开分享' : '撤销公开分享'}
                            disabled={unshare.isPending}
                            onBlur={() => {
                              if (!unshare.isPending && revokeId === link.id) setRevokeId(null);
                            }}
                            onClick={() => {
                              unshare.reset();
                              if (revokeId !== link.id) {
                                setRevokeId(link.id);
                                return;
                              }
                              unshare.mutate(link.id);
                            }}
                          >
                            {revokeId === link.id ? '确认撤销' : '撤销'}
                          </button>
                          <button className={`${BUTTON} ml-auto`} aria-label="收起分享面板" onClick={() => closeShare(link.id)}>
                            收起
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-[11px] text-tertiary">拿到链接的人不用登录就能看这个端口，到期自动失效。</p>
                        <fieldset data-testid="preview-share-hours" className="mt-1 min-w-0">
                          <legend className="sr-only">分享有效期</legend>
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            {shareHoursOptions.map((hours) => (
                              <label
                                key={hours}
                                className={`inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-sm border px-2 text-meta ${
                                  shareHours === hours ? 'border-accent text-accent' : 'border-hair text-secondary'
                                }`}
                              >
                                <input
                                  type="radio"
                                  className="size-3 accent-current"
                                  name={`preview-share-hours-${link.id}`}
                                  value={hours}
                                  checked={shareHours === hours}
                                  onChange={() => setShareHours(hours)}
                                />
                                {shareHoursLabel(hours)}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                          <button
                            data-testid="preview-share-create"
                            className={BUTTON}
                            disabled={share.isPending}
                            onClick={() => {
                              share.reset();
                              share.mutate({ linkId: link.id, hours: shareHours });
                            }}
                          >
                            {share.isPending ? '生成中…' : '生成链接'}
                          </button>
                          <button className={BUTTON} aria-label="取消分享" onClick={() => closeShare(link.id)}>
                            取消
                          </button>
                        </div>
                      </>
                    )}
                    {shareError ? (
                      <p role="alert" data-testid="preview-share-error" className="mt-1.5 break-words text-meta text-rust">
                        {shareError}
                      </p>
                    ) : null}
                  </div>
                ) : null}

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
