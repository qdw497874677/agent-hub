import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_INITIAL,
  TERMINAL_KEYS,
  TERMINAL_MAX_RETRIES,
  base64FromBytes,
  bytesFromBase64,
  encodeInput,
  isUnsupportedTerminal,
  keyBarCtrlAfter,
  keyBarSequence,
  markTerminalUnsupported,
  parseTerminalFrame,
  resetTerminalSupport,
  retryDelay,
  subscribeTerminalSupport,
  terminalErrorMessage,
  terminalPalette,
  terminalReducer,
  terminalSocketUrl,
  terminalStatus,
  terminalSupportKeys,
  terminalUnsupported,
  type TerminalKeyId,
  type TerminalState
} from './terminal-core.ts';

test('base64：UTF-8 中文与二进制往返都不走样', () => {
  const bytes = new TextEncoder().encode('你好，terminal ✓ 1234');
  assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes);
  assert.equal(base64FromBytes(new Uint8Array(0)), '');
  assert.deepEqual(bytesFromBase64(''), new Uint8Array(0));
  // 坏帧不抛，回空数组（渲染路径里不该有异常）
  assert.deepEqual(bytesFromBase64('!!!不是 base64!!!'), new Uint8Array(0));
});

test('encodeInput：按键按 UTF-8 编成 base64', () => {
  const encoded = encodeInput('a中\r');
  assert.equal(encoded, base64FromBytes(new TextEncoder().encode('a中\r')));
  assert.equal(new TextDecoder().decode(bytesFromBase64(encoded)), 'a中\r');
});

test('terminalSocketUrl：同源推 ws/wss', () => {
  assert.equal(
    terminalSocketUrl({ protocol: 'https:', host: 'hub.example:17900' }, 'ses 1'),
    'wss://hub.example:17900/api/sessions/ses%201/terminal'
  );
  assert.equal(
    terminalSocketUrl({ protocol: 'http:', host: '127.0.0.1:7878' }, 'ses-1'),
    'ws://127.0.0.1:7878/api/sessions/ses-1/terminal'
  );
});

test('parseTerminalFrame：认得的帧照收，坏帧安静丢掉', () => {
  assert.deepEqual(parseTerminalFrame('{"t":"ready","terminalId":"ses-1:1"}'), { t: 'ready', terminalId: 'ses-1:1' });
  assert.deepEqual(parseTerminalFrame('{"t":"data","d":"aGk="}'), { t: 'data', d: 'aGk=' });
  assert.deepEqual(parseTerminalFrame('{"t":"exit","code":130}'), { t: 'exit', code: 130 });
  assert.deepEqual(parseTerminalFrame('{"t":"error","message":"这台机器不支持终端"}'), {
    t: 'error',
    message: '这台机器不支持终端'
  });
  assert.deepEqual(parseTerminalFrame('{"t":"pong"}'), { t: 'pong' });
  assert.equal(parseTerminalFrame('{"t":"data"}'), null);
  assert.equal(parseTerminalFrame('{"t":"event"}'), null);
  assert.equal(parseTerminalFrame('{'), null);
  assert.equal(parseTerminalFrame('[]'), null);
  assert.equal(parseTerminalFrame(null), null);
});

test('状态机：连接 → 已连接 → 断线重连 → 次数用尽', () => {
  let state: TerminalState = TERMINAL_INITIAL;
  assert.equal(state.phase, 'connecting');
  state = terminalReducer(state, { type: 'ready' });
  assert.equal(state.phase, 'open');
  state = terminalReducer(state, { type: 'size', cols: 120, rows: 32 });
  assert.deepEqual([state.cols, state.rows], [120, 32]);
  state = terminalReducer(state, { type: 'retrying', attempt: 1 });
  assert.equal(state.phase, 'reconnecting');
  assert.equal(state.attempt, 1);
  state = terminalReducer(state, { type: 'data' });
  assert.equal(state.phase, 'open');
  assert.equal(state.attempt, 0);
  state = terminalReducer(state, { type: 'closed' });
  assert.equal(state.phase, 'closed');
});

test('状态机：退出和 error 是终态，迟到的输出不会把它拽回「已连接」', () => {
  const open = terminalReducer(TERMINAL_INITIAL, { type: 'ready' });
  const exited = terminalReducer(open, { type: 'exit', code: 137 });
  assert.equal(exited.phase, 'exited');
  assert.equal(exited.exitCode, 137);
  assert.equal(terminalReducer(exited, { type: 'data' }), exited);

  const failed = terminalReducer(open, { type: 'error', message: '这台机器不支持终端' });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.message, '这台机器不支持终端');
  assert.equal(terminalReducer(failed, { type: 'data' }), failed);

  // 手动重连回到连接中，清掉上一局的退出码和原因
  const again = terminalReducer(exited, { type: 'connecting' });
  assert.equal(again.phase, 'connecting');
  assert.equal(again.exitCode, null);
  assert.equal(again.message, null);
});

test('状态机：尺寸同值时不换对象（少一次渲染）', () => {
  const sized = terminalReducer(TERMINAL_INITIAL, { type: 'size', cols: 80, rows: 24 });
  assert.equal(terminalReducer(sized, { type: 'size', cols: 80, rows: 24 }), sized);
  assert.notEqual(terminalReducer(sized, { type: 'size', cols: 81, rows: 24 }), sized);
});

test('retryDelay：500ms 起翻倍，最多 5 次', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(retryDelay),
    [500, 1000, 2000, 4000, 8000]
  );
  assert.equal(TERMINAL_MAX_RETRIES, 5);
});

test('terminalStatus：每种状态一行字 + 语气', () => {
  assert.deepEqual(terminalStatus(TERMINAL_INITIAL), { text: '正在连接终端…', tone: 'busy' });
  const open = terminalReducer(TERMINAL_INITIAL, { type: 'size', cols: 120, rows: 32 });
  assert.deepEqual(terminalStatus(terminalReducer(open, { type: 'ready' })), { text: '已连接 · 120×32', tone: 'ok' });
  assert.deepEqual(terminalStatus(terminalReducer(open, { type: 'retrying', attempt: 2 })), {
    text: '连接中断，正在重连（2/5）…',
    tone: 'busy'
  });
  assert.deepEqual(terminalStatus(terminalReducer(open, { type: 'closed' })), {
    text: '已断开 · 自动重连已停止',
    tone: 'bad'
  });
  assert.deepEqual(terminalStatus(terminalReducer(open, { type: 'exit', code: 0 })), {
    text: '[进程已退出（code 0）]',
    tone: 'bad'
  });
  assert.deepEqual(terminalStatus(terminalReducer(open, { type: 'error', message: '机器离线' })), {
    text: '机器离线，终端暂时不可用',
    tone: 'bad'
  });
});

test('错误文案：认得的翻成统一说法，不认得的原样透出', () => {
  assert.equal(terminalErrorMessage('unsupported'), '这台机器不支持终端');
  assert.equal(terminalErrorMessage('这台机器不支持终端'), '这台机器不支持终端');
  assert.equal(terminalErrorMessage('机器离线'), '机器离线，终端暂时不可用');
  assert.equal(terminalErrorMessage('这个终端已在另一个窗口打开'), '这个终端已在另一个窗口打开');
  assert.equal(terminalErrorMessage('这条会话还没有工作空间'), '这条会话还没有工作空间，终端没有落脚的地方');
  assert.equal(terminalErrorMessage('PTY 开不出来'), 'PTY 开不出来');
  assert.equal(terminalErrorMessage(''), '终端连接出错，稍后再试');
  assert.equal(terminalErrorMessage(undefined), '终端连接出错，稍后再试');
});

test('isUnsupportedTerminal：英文错误码与中文说法都认', () => {
  assert.equal(isUnsupportedTerminal('unsupported'), true);
  assert.equal(isUnsupportedTerminal('TERMINAL_UNSUPPORTED'), true);
  assert.equal(isUnsupportedTerminal('这台机器不支持终端'), true);
  assert.equal(isUnsupportedTerminal('机器离线'), false);
  assert.equal(isUnsupportedTerminal(undefined), false);
});

test('支持探测缓存：记住后通知订阅方，刷新/复位能清掉', () => {
  resetTerminalSupport();
  const keys = terminalSupportKeys('remote-7ecd');
  assert.deepEqual(keys, ['worker:remote-7ecd']);
  // 老会话没有 workerId：算到本机那台
  assert.deepEqual(terminalSupportKeys(null), ['worker:local']);

  let notified = 0;
  const unsubscribe = subscribeTerminalSupport(() => {
    notified += 1;
  });
  assert.equal(terminalUnsupported(keys), false);
  markTerminalUnsupported(keys);
  // 同机另一条会话（只要 worker 相同）也一起隐藏
  assert.equal(terminalUnsupported(['worker:remote-7ecd']), true);
  assert.equal(terminalUnsupported(['worker:other']), false);
  assert.equal(notified, 1);
  // 重复标记不再通知
  markTerminalUnsupported(keys);
  assert.equal(notified, 1);
  unsubscribe();
  resetTerminalSupport();
  assert.equal(terminalUnsupported(keys), false);
  markTerminalUnsupported(keys);
  assert.equal(notified, 1);
  resetTerminalSupport();
});

test('配色：深浅两套都齐，且确实不一样', () => {
  const dark = terminalPalette('dark');
  const light = terminalPalette('light');
  const names = [
    'background',
    'foreground',
    'cursor',
    'cursorAccent',
    'selectionBackground',
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
  ] as const;
  for (const name of names) {
    assert.match(dark[name], /^#[0-9a-f]{6,8}$/, `dark.${name}`);
    assert.match(light[name], /^#[0-9a-f]{6,8}$/, `light.${name}`);
  }
  assert.notEqual(dark.background, light.background);
  assert.notEqual(dark.foreground, light.foreground);
});

test('按键条：键位顺序与键面文字固定（中文与符号混排）', () => {
  assert.deepEqual(
    TERMINAL_KEYS.map((key) => key.id),
    ['esc', 'tab', 'ctrl', 'up', 'down', 'left', 'right', 'ctrl-c']
  );
  assert.deepEqual(
    TERMINAL_KEYS.map((key) => key.label),
    ['Esc', 'Tab', 'Ctrl', '↑', '↓', '←', '→', 'Ctrl+C']
  );
});

test('按键条：发码走 xterm 的既有输入管线，粘滞 Ctrl 只作用于方向键', () => {
  assert.equal(keyBarSequence('esc'), '\x1b');
  assert.equal(keyBarSequence('tab'), '\t');
  assert.equal(keyBarSequence('ctrl-c'), '\x03');
  // 修饰键自己不发字节；Ctrl+C 本来就是 ETX，再叠一次 Ctrl 还是它
  assert.equal(keyBarSequence('ctrl'), '');
  assert.equal(keyBarSequence('ctrl-c', true), '\x03');

  const arrows: readonly TerminalKeyId[] = ['up', 'down', 'right', 'left'];
  assert.deepEqual(arrows.map((key) => keyBarSequence(key)), ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  assert.deepEqual(arrows.map((key) => keyBarSequence(key, true)), [
    '\x1b[1;5A',
    '\x1b[1;5B',
    '\x1b[1;5C',
    '\x1b[1;5D'
  ]);

  // Esc / Tab 没有有意义的 Ctrl 变体，带着修饰也还是原样
  assert.equal(keyBarSequence('esc', true), '\x1b');
  assert.equal(keyBarSequence('tab', true), '\t');
});

test('按键条：粘滞 Ctrl 是一次性修饰，点 Ctrl 自己才切换', () => {
  assert.equal(keyBarCtrlAfter('ctrl', false), true);
  assert.equal(keyBarCtrlAfter('ctrl', true), false);
  for (const key of ['esc', 'tab', 'up', 'down', 'left', 'right', 'ctrl-c'] as const) {
    assert.equal(keyBarCtrlAfter(key, true), false, `${key} 应该把 Ctrl 吸掉`);
    assert.equal(keyBarCtrlAfter(key, false), false, `${key} 不该点亮 Ctrl`);
  }
});
