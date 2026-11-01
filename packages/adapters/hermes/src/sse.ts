/**
 * 最小的 SSE 解析：按空行分帧，`data:` 拼起来，`:` 开头的注释（Hermes 每 10 秒一行保活）跳过。
 * 返回 `id` 方便断线后对账（Hermes 的 id 就是 seq）。
 */
export interface SseFrame {
  readonly id: string | null;
  readonly data: string;
}

export function createSseParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = '';
  let data: string[] = [];
  let id: string | null = null;
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === '') {
        if (data.length > 0) onFrame({ id, data: data.join('\n') });
        data = [];
        id = null;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
  };
}
