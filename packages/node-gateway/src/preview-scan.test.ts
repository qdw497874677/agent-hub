import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREVIEW_PORT_PATTERN, portsInOutput, scanListeningPorts } from './preview-scan.ts';

/**
 * 端口发现的两条输入（docs/design/preview.md §5）：/proc 里的 LISTEN 端口、
 * 终端输出里的 `host:port`。测试不读真 /proc：临时目录冒充 procRoot。
 */

/** /proc/net/tcp 的列：本地地址、远端地址、状态（0A = LISTEN）。 */
function procLine(local: string, remote: string, state: string): string {
  return `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
}

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

interface FakeProc {
  readonly root: string;
  close(): void;
}

function fakeProc(files: { tcp?: readonly string[]; tcp6?: readonly string[] }): FakeProc {
  const root = mkdtempSync(join(tmpdir(), 'ah-preview-scan-'));
  mkdirSync(join(root, 'net'), { recursive: true });
  if (files.tcp !== undefined) writeFileSync(join(root, 'net', 'tcp'), [HEADER, ...files.tcp, ''].join('\n'));
  if (files.tcp6 !== undefined) writeFileSync(join(root, 'net', 'tcp6'), [HEADER, ...files.tcp6, ''].join('\n'));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('scanListeningPorts：只取回环 / 全接口的 LISTEN，排除 ESTABLISHED，tcp 与 tcp6 合并去重升序', () => {
  const proc = fakeProc({
    tcp: [
      // 127.0.0.1:8080
      procLine('0100007F:1F90', '00000000:0000', '0A'),
      // 0.0.0.0:3000
      procLine('00000000:0BB8', '00000000:0000', '0A'),
      // 127.0.0.1 -> 127.0.0.1 的已建立连接（不是监听，必须排除）
      procLine('0100007F:1F90', '0100007F:D431', '01'),
      // 绑在网卡地址 192.168.1.10:9000（不代理，必须排除）
      procLine('0A01A8C0:2328', '00000000:0000', '0A')
    ],
    tcp6: [
      // :::8081（全接口）
      procLine('00000000000000000000000000000000:1F91', '00000000000000000000000000000000:0000', '0A'),
      // ::1:5000
      procLine('00000000000000000000000001000000:1388', '00000000000000000000000000000000:0000', '0A'),
      // ::1 上的已建立连接（排除）
      procLine('00000000000000000000000001000000:1388', '00000000000000000000000001000000:D431', '01')
    ]
  });
  try {
    assert.deepEqual(scanListeningPorts({ procRoot: proc.root }), [3000, 5000, 8080, 8081]);
  } finally {
    proc.close();
  }
});

test('scanListeningPorts：缺文件 / 读不了时返回空数组，不抛', () => {
  assert.deepEqual(scanListeningPorts({ procRoot: join(tmpdir(), 'ah-preview-scan-does-not-exist') }), []);
  // 只有 tcp、没有 tcp6：照样能扫
  const proc = fakeProc({ tcp: [procLine('0100007F:1F90', '00000000:0000', '0A')] });
  try {
    assert.deepEqual(scanListeningPorts({ procRoot: proc.root }), [8080]);
  } finally {
    proc.close();
  }
});

test('portsInOutput：认 localhost / 127.0.0.1 / 0.0.0.0 / [::1]，label 取整行', () => {
  const text = ['  Local:   http://localhost:5173/', '> Listening on 127.0.0.1:8000', 'ready on 0.0.0.0:4321', 'ws://[::1]:9000/ws'].join('\n');
  assert.deepEqual(portsInOutput(text), [
    { port: 5173, label: 'Local:   http://localhost:5173/' },
    { port: 8000, label: '> Listening on 127.0.0.1:8000' },
    { port: 4321, label: 'ready on 0.0.0.0:4321' },
    { port: 9000, label: 'ws://[::1]:9000/ws' }
  ]);
});

test('portsInOutput：没有地址的 --port 不认，低端口与超范围不要，同一行同端口只算一次', () => {
  assert.deepEqual(portsInOutput('server started with --port 3000'), []);
  assert.deepEqual(portsInOutput('bound to localhost:80'), []);
  assert.deepEqual(portsInOutput('localhost:70000'), []);
  assert.deepEqual(portsInOutput('http://localhost:5173 and again localhost:5173'), [
    { port: 5173, label: 'http://localhost:5173 and again localhost:5173' }
  ]);
  assert.deepEqual(portsInOutput(''), []);
});

test('PREVIEW_PORT_PATTERN 是契约里的写法（不含 /g，方便复用）', () => {
  assert.equal(PREVIEW_PORT_PATTERN.global, false);
  assert.match('http://localhost:5173/', PREVIEW_PORT_PATTERN);
});
