import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 预览的端口发现（docs/design/preview.md §5）：两条互不依赖的输入。
 *
 * - `scanListeningPorts`：这台机器上正在 LISTEN 的**回环 / 全接口**端口。地址是 `/proc/net/tcp{,6}`
 *   里的十六进制小端写法，不是给用户看的；服务绑在内网网卡上的不报（要暴露必须显式勾非回环）。
 * - `portsInOutput`：从终端 / 进程输出里认出 `localhost:5173` 这类写法，只负责**提议**，
 *   真正上报前还要过 `scanListeningPorts` 这一关（见 preview-client 的 `detect`）。
 *
 * 读不到 `/proc`（非 Linux、容器里没挂、权限不够）一律当作「没有端口」，不抛。
 */

/** 终端输出里认得的预览端口写法；`--port 3000` 这种没有地址的刻意不认。 */
export const PREVIEW_PORT_PATTERN = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/;

/** 提议的端口只取非特权段：80 / 443 是 agent 自己起的服务时几乎不可能是预览。 */
const MIN_DETECTED_PORT = 1024;
const MAX_PORT = 65535;
/** label 与契约 `PreviewLinkDto.label` 对齐（≤60 字）。 */
const LABEL_MAX = 60;

/** `/proc/net/tcp` 里可接受的 local 地址（大写十六进制，IPv4 按字节倒序）。 */
const LOOPBACK_V4 = new Set(['0100007F', '00000000']);
/** `::` 与 `::1`：IPv6 按 4 个 32 位小端字写，所以 `::1` 是最后一字 `01000000`。 */
const LOOPBACK_V6 = new Set([
  '00000000000000000000000000000000',
  '00000000000000000000000001000000'
]);

export interface ScanListeningOptions {
  /** `/proc` 的替身（测试注入临时目录）；默认 `/proc`。 */
  readonly procRoot?: string;
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    // 没这个文件 / 读不了：当作没有监听端口（非 Linux 上预览探测只是不生效）
    return [];
  }
}

/** 解析一种地址族；`fields[1]` 是 local（`ADDR:PORT`），`fields[3]` 是 state。 */
function collectListening(lines: readonly string[], loopback: ReadonlySet<string>, ports: Set<number>): void {
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    // 0A = LISTEN；ESTABLISHED（01）等一律不算。
    if (fields[3] !== '0A') continue;
    const local = fields[1] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon <= 0) continue;
    const address = local.slice(0, colon).toUpperCase();
    if (!loopback.has(address)) continue;
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
    ports.add(port);
  }
}

/**
 * 这台机器上 LISTEN 的回环 / 全接口端口，去重升序。
 * 只认 `127.0.0.1`、`0.0.0.0`、`::`、`::1` 这四种绑定。
 */
export function scanListeningPorts(options: ScanListeningOptions = {}): number[] {
  const root = options.procRoot ?? '/proc';
  const ports = new Set<number>();
  collectListening(readLines(join(root, 'net', 'tcp')), LOOPBACK_V4, ports);
  collectListening(readLines(join(root, 'net', 'tcp6')), LOOPBACK_V6, ports);
  return [...ports].sort((a, b) => a - b);
}

/**
 * 从一段文本里找出「像预览」的端口。按行找：同一行里的同一个端口只算一次，
 * label 就是那一行（trim 后截到 60 字），让用户知道这个端口是从哪冒出来的。
 */
export function portsInOutput(text: string): { port: number; label: string }[] {
  const hits: { port: number; label: string }[] = [];
  if (text === '') return hits;
  const matcher = new RegExp(PREVIEW_PORT_PATTERN.source, 'g');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const seen = new Set<number>();
    for (const match of line.matchAll(matcher)) {
      const port = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isInteger(port) || port < MIN_DETECTED_PORT || port > MAX_PORT) continue;
      if (seen.has(port)) continue;
      seen.add(port);
      hits.push({ port, label: line.trim().slice(0, LABEL_MAX) });
    }
  }
  return hits;
}
