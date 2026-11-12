import { useEffect, useReducer, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  TERMINAL_INITIAL,
  TERMINAL_MAX_RETRIES,
  bytesFromBase64,
  encodeInput,
  isUnsupportedTerminal,
  markTerminalUnsupported,
  parseTerminalFrame,
  retryDelay,
  terminalPalette,
  terminalReducer,
  terminalSocketUrl,
  terminalStatus,
  terminalSupportKeys,
  type TerminalClientFrame
} from './terminal-core.ts';

/** 断线时最多缓这么多字符（base64）；再长的按键丢掉，重连后一口气灌回去也不会有意义。 */
const PENDING_LIMIT = 64 * 1024;
/** 尺寸变化节流（§7）：拖窗口时不要每个像素都 fit 一次。 */
const RESIZE_THROTTLE_MS = 120;
/** 心跳（§2.2）：25s 一次，连续两次没有回音就当链路死了。 */
const PING_MS = 25_000;

interface Props {
  readonly sessionId: string;
  readonly workerId: string | null;
  /** 页签是否在前台：决定要不要 fit / 抢焦点；切走时实例保留。 */
  readonly active: boolean;
}

function prefersLight(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
}

/** 手机上抢焦点会把键盘顶起来，挡住刚打开的终端；交给用户自己点。 */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
}

/**
 * 会话终端（docs/design/terminal.md §7）。
 *
 * xterm 只负责画和收键；WS 的建/断/退避/尺寸都在一个 effect 里，一处说了算。
 * 页签切走不 dispose：PTY 在机器上还活着，回来要接回原现场（连滚回去的历史一起）。
 */
export function TerminalPanel({ sessionId, workerId, active }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, dispatch] = useReducer(terminalReducer, TERMINAL_INITIAL);
  const fitRef = useRef<(force?: boolean) => void>(() => {});
  const restartRef = useRef<(reset: boolean) => void>(() => {});
  const activeRef = useRef(active);
  const workerIdRef = useRef(workerId);
  activeRef.current = active;
  workerIdRef.current = workerId;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // ------------------------------------------------------------ xterm ------------------------------------------------------------
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 600,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5_000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: true,
      theme: terminalPalette(prefersLight() ? 'light' : 'dark')
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const lightMedia = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
    const applyTheme = () => {
      term.options.theme = terminalPalette(lightMedia?.matches ? 'light' : 'dark');
    };
    lightMedia?.addEventListener?.('change', applyTheme);

    // ------------------------------------------------------------ 连接 ------------------------------------------------------------
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let silentPings = 0;
    let attempts = 0;
    /** 退出 / error 之后是终态，不再自动重连；手动「重连 / 新开一个」才复位。 */
    let stopped = false;
    let disposed = false;
    let pending: string[] = [];
    let pendingChars = 0;
    let sent = { cols: 0, rows: 0 };

    const send = (frame: TerminalClientFrame) => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    const stopPing = () => {
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = null;
      silentPings = 0;
    };

    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        if (silentPings >= 2) {
          // 两次没有回音：主动关掉，让 onclose 走退避重连。
          try {
            socket?.close();
          } catch {
            /* 已经断了 */
          }
          return;
        }
        silentPings += 1;
        send({ t: 'ping' });
      }, PING_MS);
    };

    /**
     * 对齐尺寸。容器不可见（display:none，宽或高为 0）时跳过：
     * 0 列 fit 出来的网格送回去只会被服务端按非法尺寸拒掉，回到页签还得再来一遍。
     */
    const fitAndResize = (force = false) => {
      if (disposed) return;
      const el = hostRef.current;
      if (el === null || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      if (cols <= 0 || rows <= 0) return;
      dispatch({ type: 'size', cols, rows });
      if (!force && cols === sent.cols && rows === sent.rows) return;
      sent = { cols, rows };
      send({ t: 'resize', cols, rows });
    };
    fitRef.current = fitAndResize;

    const fail = (message: string) => {
      stopped = true;
      dispatch({ type: 'error', message });
      if (isUnsupportedTerminal(message)) {
        markTerminalUnsupported(terminalSupportKeys(sessionId, workerIdRef.current));
      }
      try {
        socket?.close();
      } catch {
        /* 已经断了 */
      }
    };

    function connect(): void {
      if (disposed || stopped) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(terminalSocketUrl(window.location, sessionId));
      } catch {
        fail('终端连接失败');
        return;
      }
      socket = ws;

      ws.onopen = () => {
        silentPings = 0;
        // 断线期间敲的键先补上，再对齐尺寸（顺序反了会让 shell 按旧宽度重绘）。
        for (const chunk of pending) send({ t: 'input', d: chunk });
        pending = [];
        pendingChars = 0;
        fitAndResize(true);
        startPing();
      };

      ws.onmessage = (event) => {
        silentPings = 0;
        const frame = parseTerminalFrame(event.data);
        if (frame === null) return;
        switch (frame.t) {
          case 'ready':
            dispatch({ type: 'ready' });
            if (activeRef.current) {
              requestAnimationFrame(() => {
                fitAndResize(true);
                if (!coarsePointer()) term.focus();
              });
            }
            break;
          case 'data':
            term.write(bytesFromBase64(frame.d));
            dispatch({ type: 'data' });
            break;
          case 'exit':
            stopped = true;
            // PTY 没了就别再敲心跳；socket 由服务端收尾，onclose 看到 stopped 不会重连。
            stopPing();
            term.write(`\r\n\x1b[2m[进程已退出（code ${frame.code}）]\x1b[0m\r\n`);
            dispatch({ type: 'exit', code: frame.code });
            break;
          case 'error':
            fail(frame.message);
            break;
          case 'pong':
            break;
        }
      };

      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        stopPing();
        if (disposed || stopped) return;
        if (attempts >= TERMINAL_MAX_RETRIES) {
          dispatch({ type: 'closed' });
          return;
        }
        attempts += 1;
        dispatch({ type: 'retrying', attempt: attempts });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, retryDelay(attempts));
      };

      // onerror 后面一定会跟一条 onclose，收尾只写在一处。
      ws.onerror = () => undefined;
    }

    const restart = (reset: boolean) => {
      if (disposed) return;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      stopped = false;
      pending = [];
      pendingChars = 0;
      sent = { cols: 0, rows: 0 };
      try {
        socket?.close();
      } catch {
        /* 已经断了 */
      }
      socket = null;
      stopPing();
      // 「新开一个」换的是新的 shell：上一局的输出留着只会让人以为还连着。
      if (reset) term.reset();
      dispatch({ type: 'connecting' });
      connect();
    };
    restartRef.current = restart;

    // ------------------------------------------------------------ 输入 ------------------------------------------------------------
    const dataSub = term.onData((text) => {
      if (text === '') return;
      const payload = encodeInput(text);
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'input', d: payload } satisfies TerminalClientFrame));
        return;
      }
      // 还没连上（首次连接、断线重连中）：先攒着，onopen 时补发。
      if (pendingChars + payload.length > PENDING_LIMIT) return;
      pending.push(payload);
      pendingChars += payload.length;
    });

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      stopPing();
      dataSub.dispose();
      lightMedia?.removeEventListener?.('change', applyTheme);
      fitRef.current = () => {};
      restartRef.current = () => {};
      const ws = socket;
      socket = null;
      if (ws !== null) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* 已经断了 */
        }
      }
      term.dispose();
    };
  }, [sessionId]);

  // 尺寸：ResizeObserver 节流 120ms；容器为 0 时 fitAndResize 自己跳过。
  useEffect(() => {
    const el = hostRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        fitRef.current();
      }, RESIZE_THROTTLE_MS);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // 切回页签：display 从 none 变回来，尺寸此刻才量得准，等一帧再 fit。
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => fitRef.current(true));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const status = terminalStatus(state);
  const retryLabel = state.phase === 'exited' ? '新开一个' : state.phase === 'reconnecting' ? '立即重连' : '重连';
  const showRetry =
    state.phase === 'reconnecting' || state.phase === 'closed' || state.phase === 'failed' || state.phase === 'exited';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas" data-testid="terminal-pane">
      <div ref={hostRef} className="terminal-host min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1.5" />
      <div
        data-testid="terminal-status"
        className="flex h-8 shrink-0 items-center gap-2 border-t border-hair bg-panel px-2.5 text-meta"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            status.tone === 'ok' ? 'bg-sage' : status.tone === 'busy' ? 'animate-pulse bg-accent' : 'bg-rust'
          }`}
        />
        <span
          aria-live={state.phase === 'open' ? 'off' : 'polite'}
          className={`min-w-0 truncate ${
            status.tone === 'ok' ? 'text-tertiary' : status.tone === 'busy' ? 'text-secondary' : 'text-primary'
          }`}
        >
          {status.text}
        </span>
        {showRetry ? (
          <button
            type="button"
            data-testid="terminal-reconnect"
            className="ml-auto h-6 shrink-0 rounded-sm border border-strong px-2 text-meta text-primary hover:border-accent hover:text-accent"
            onClick={() => restartRef.current(state.phase === 'exited')}
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
