/**
 * 严格 JSONL 切帧。
 *
 * 不能用 Node 的 `readline`：它把 U+2028 / U+2029 也当行分隔符，
 * 而这两个字符在 JSON 字符串里是合法的。Pi 与 ACP 都要求只按 LF 切。
 */
export async function* jsonlRecords(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') yield line;
      index = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  const tail = buffer.replace(/\r$/, '');
  if (tail.trim() !== '') yield tail;
}
