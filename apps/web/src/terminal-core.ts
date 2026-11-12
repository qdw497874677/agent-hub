/**
 * 终端页签里不碰 DOM 的那一半：base64 编解码、WS 地址、连接状态机、文案、配色、支持探测缓存。
 *
 * 单测在 node 里直接跑（不装 jsdom、不实例化 xterm）。带 DOM/xterm 的部分在 terminal-panel.tsx。
 */

// ---------------------------------------------------------------- 协议 ----------------------------------------------------------------

/** 浏览器→hub 的帧（docs/design/terminal.md §2.2）。 */
export type TerminalClientFrame =
  | { readonly t: 'input'; readonly d: string }
  | { readonly t: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly t: 'ping' };

/** hub→浏览器的帧。未知类型原样忽略（老 hub / 新 hub 混跑时不炸）。 */
export type TerminalServerFrame =
  | { readonly t: 'ready'; readonly terminalId: string }
  | { readonly t: 'data'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number }
  | { readonly t: 'error'; readonly message: string }
  | { readonly t: 'pong' };

/** 服务端是一帧 JSON；坏帧（截断、非 JSON、没 t）返回 null，让调用方安静丢掉。 */
export function parseTerminalFrame(raw: unknown): TerminalServerFrame | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as { t?: unknown; d?: unknown; code?: unknown; message?: unknown; terminalId?: unknown };
  switch (frame.t) {
    case 'ready':
      return { t: 'ready', terminalId: typeof frame.terminalId === 'string' ? frame.terminalId : '' };
    case 'data':
      return typeof frame.d === 'string' ? { t: 'data', d: frame.d } : null;
    case 'exit':
      return { t: 'exit', code: typeof frame.code === 'number' && Number.isFinite(frame.code) ? frame.code : 0 };
    case 'error':
      return { t: 'error', message: typeof frame.message === 'string' ? frame.message : '' };
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- base64 ----------------------------------------------------------------

/** 字节 → base64。分块拼字符串，避免 64 KB 的帧把 `fromCharCode` 的参数栈撑爆。 */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → 字节。解不开就回空数组：宁可少画一行，也不要抛进 React 的渲染里。 */
export function bytesFromBase64(data: string): Uint8Array {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/** 按键（含中文、粘贴的多行）按 UTF-8 编码成 base64；协议统一用字节，避免 JSON 切断多字节字符。 */
export function encodeInput(text: string): string {
  return base64FromBytes(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------- 连接地址 ----------------------------------------------------------------

/**
 * 同源推 ws/wss：`window.location` 里是什么协议就用什么。
 * 写死 http 会在 HTTPS 部署上被浏览器当混合内容拦掉。
 */
export function terminalSocketUrl(location: { readonly protocol: string; readonly host: string }, sessionId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal`;
}

// ---------------------------------------------------------------- 状态机 ----------------------------------------------------------------

export const TERMINAL_MAX_RETRIES = 5;
export const TERMINAL_RETRY_BASE_MS = 500;

/** 指数退避：0.5s、1s、2s、4s、8s。 */
export function retryDelay(attempt: number): number {
  return TERMINAL_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

export type TerminalPhase = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'exited' | 'failed';

export interface TerminalState {
  readonly phase: TerminalPhase;
  /** 已经尝试过的自动重连次数（0 = 还没重连过）。 */
  readonly attempt: number;
  /** 失败原因（已经翻成人话）。 */
  readonly message: string | null;
  readonly exitCode: number | null;
  /** 最近一次对齐的列/行，状态栏里显示，也用来去重 resize 帧。 */
  readonly cols: number;
  readonly rows: number;
}

export const TERMINAL_INITIAL: TerminalState = {
  phase: 'connecting',
  attempt: 0,
  message: null,
  exitCode: null,
  cols: 0,
  rows: 0
};

export type TerminalEvent =
  /** 首次连接 / 用户手动重连。 */
  | { readonly type: 'connecting' }
  /** hub 回了 ready（PTY 已就绪）。 */
  | { readonly type: 'ready' }
  /** 收到任意输出：老 hub 可能不发 ready，用输出当「已连上」。 */
  | { readonly type: 'data' }
  /** 断线后的第 attempt 次自动重连。 */
  | { readonly type: 'retrying'; readonly attempt: number }
  /** 自动重连次数用尽。 */
  | { readonly type: 'closed' }
  | { readonly type: 'exit'; readonly code: number | null }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'size'; readonly cols: number; readonly rows: number };

export function terminalReducer(state: TerminalState, event: TerminalEvent): TerminalState {
  switch (event.type) {
    case 'connecting':
      return { ...state, phase: 'connecting', attempt: 0, message: null, exitCode: null };
    case 'ready':
    case 'data':
      // 已经退出/失败的终端不再被迟到的输出拽回「已连接」。
      if (state.phase === 'exited' || state.phase === 'failed') return state;
      if (state.phase === 'open' && state.message === null) return state;
      return { ...state, phase: 'open', attempt: 0, message: null, exitCode: null };
    case 'retrying':
      return { ...state, phase: 'reconnecting', attempt: event.attempt, message: null };
    case 'closed':
      return { ...state, phase: 'closed', message: null };
    case 'exit':
      return { ...state, phase: 'exited', exitCode: event.code, message: null };
    case 'error':
      return { ...state, phase: 'failed', attempt: 0, message: terminalErrorMessage(event.message) };
    case 'size':
      if (event.cols === state.cols && event.rows === state.rows) return state;
      return { ...state, cols: event.cols, rows: event.rows };
    default:
      return state;
  }
}

/** 只有断线且还没把 5 次用完时才自动重连；退出和 error 都是终态（error 不自动重试）。 */
export function shouldAutoRetry(state: TerminalState): boolean {
  return state.phase === 'reconnecting' && state.attempt <= TERMINAL_MAX_RETRIES;
}

// ---------------------------------------------------------------- 文案 ----------------------------------------------------------------

export interface TerminalStatusLine {
  readonly text: string;
  readonly tone: 'ok' | 'busy' | 'bad';
}

/** 状态栏那一行字：连接中 / 已连接 · 120×32 / 第 n 次重连 / 退出码 / 失败原因。 */
export function terminalStatus(state: TerminalState): TerminalStatusLine {
  switch (state.phase) {
    case 'connecting':
      return { text: '正在连接终端…', tone: 'busy' };
    case 'open':
      return {
        text: state.cols > 0 && state.rows > 0 ? `已连接 · ${state.cols}×${state.rows}` : '已连接',
        tone: 'ok'
      };
    case 'reconnecting':
      return {
        text: `连接中断，正在重连（${Math.min(state.attempt, TERMINAL_MAX_RETRIES)}/${TERMINAL_MAX_RETRIES}）…`,
        tone: 'busy'
      };
    case 'closed':
      return { text: '已断开 · 自动重连已停止', tone: 'bad' };
    case 'exited':
      return { text: `[进程已退出（code ${state.exitCode ?? 0}）]`, tone: 'bad' };
    case 'failed':
      return { text: state.message ?? '终端不可用', tone: 'bad' };
    default:
      return { text: '正在连接终端…', tone: 'busy' };
  }
}

/**
 * 服务端错误 → 界面上的一句话。
 * 认得的几种翻成统一说法（同一件事别在不同地方两种写法），不认得的原样透出——别把有用的原因吞掉。
 */
export function terminalErrorMessage(message: string | undefined): string {
  const text = (message ?? '').trim();
  if (text === '') return '终端连接出错，稍后再试';
  if (isUnsupportedTerminal(text)) return '这台机器不支持终端';
  if (/离线|offline/i.test(text)) return '机器离线，终端暂时不可用';
  if (/另一个窗口|另一处|already open|already in use/i.test(text)) return '这个终端已在另一个窗口打开';
  if (/没有工作空间|no workspace/i.test(text)) return '这条会话还没有工作空间，终端没有落脚的地方';
  return text;
}

/** 老 worker 没装 node-pty 时 hub 回 `unsupported`；中文部署也可能只回「不支持」。 */
export function isUnsupportedTerminal(message: string | undefined): boolean {
  return /unsupported|not supported|不支持/i.test(message ?? '');
}

// ---------------------------------------------------------------- 支持探测缓存 ----------------------------------------------------------------

/**
 * 探测到「这台机器不支持终端」之后记住它，页签就不再出现。
 * module 级 Map/Set 足够：刷新页面重探一次，代价只是一条 error 帧；不必落库。
 */
const unsupported = new Set<string>();
const listeners = new Set<() => void>();

/** 一台机器可能被多条会话共用；键同时给 worker 和 session，任一命中就算不可用。 */
export function terminalSupportKeys(sessionId: string, workerId: string | null): readonly string[] {
  return [workerId ? `worker:${workerId}` : 'worker:local', `session:${sessionId}`];
}

export function markTerminalUnsupported(keys: readonly string[]): void {
  let changed = false;
  for (const key of keys) {
    if (unsupported.has(key)) continue;
    unsupported.add(key);
    changed = true;
  }
  if (!changed) return;
  for (const listener of [...listeners]) listener();
}

export function terminalUnsupported(keys: readonly string[]): boolean {
  return keys.some((key) => unsupported.has(key));
}

export function subscribeTerminalSupport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只给测试用：清掉记住的探测结果。 */
export function resetTerminalSupport(): void {
  unsupported.clear();
  for (const listener of [...listeners]) listener();
}

// ---------------------------------------------------------------- 配色 ----------------------------------------------------------------

/**
 * 配色跟应用令牌走（styles.css 的 @theme），ANSI 十六色也按这套暖色调选，
 * 这样 `ls --color`、`git diff`、`top` 的颜色和界面是一家人，不会跳出一片荧光绿。
 */
export interface TerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorAccent: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

const DARK: TerminalTheme = {
  background: '#14181a',
  foreground: '#e8e3d9',
  cursor: '#d9a05b',
  cursorAccent: '#14181a',
  selectionBackground: '#d9a05b40',
  black: '#2e3639',
  red: '#c08a6a',
  green: '#82a394',
  yellow: '#d9a05b',
  blue: '#8aa9bb',
  magenta: '#b394ad',
  cyan: '#8fb0a8',
  white: '#e8e3d9',
  brightBlack: '#8b9690',
  brightRed: '#db9e78',
  brightGreen: '#9dbfae',
  brightYellow: '#ebbb7c',
  brightBlue: '#a6c2d2',
  brightMagenta: '#cbb0c5',
  brightCyan: '#a9c9c0',
  brightWhite: '#f5f1e8'
};

const LIGHT: TerminalTheme = {
  background: '#f7f4ee',
  foreground: '#24292b',
  cursor: '#a5712f',
  cursorAccent: '#f7f4ee',
  selectionBackground: '#d9a05b55',
  black: '#3c4649',
  red: '#a35f3e',
  green: '#4f7466',
  yellow: '#9a6b26',
  blue: '#3f6b86',
  magenta: '#7d5877',
  cyan: '#3f7570',
  white: '#d9d2c4',
  brightBlack: '#6b7570',
  brightRed: '#8c4a2c',
  brightGreen: '#3e6152',
  brightYellow: '#7f5518',
  brightBlue: '#2f5a74',
  brightMagenta: '#6a4764',
  brightCyan: '#2f625d',
  brightWhite: '#fdfbf6'
};

export function terminalPalette(mode: 'dark' | 'light'): TerminalTheme {
  return mode === 'light' ? LIGHT : DARK;
}
