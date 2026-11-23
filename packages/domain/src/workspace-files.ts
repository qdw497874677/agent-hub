/**
 * 工作空间文件浏览的纯规则（ADR 0025）：路径合法性、敏感文件、上限。适配器和用例共用。
 */
export const FILES_LIMITS = {
  previewBytes: 1024 * 1024,
  downloadBytes: 20 * 1024 * 1024,
  dirEntries: 1000,
  findResults: 50,
  diffBytes: 512 * 1024,
  watchPoints: 200,
  /** 持续每秒最多这么多。打开改动页再切一轮，同一秒会超过这个数。 */
  requestsPerSecond: 20,
  /** 开头允许攒下的次数。检查点页实测同一秒会到 21，20 的整秒桶会把下一轮读成 503。 */
  requestBurst: 40
} as const;

/** 相对路径：'' 是根；不许绝对路径、..、NUL、反斜杠，也不许碰 .git。 */
export function isBrowsablePath(path: string): boolean {
  if (path === '') return true;
  if (path.length > 4096 || path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

const SENSITIVE = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /\.p12$/i];

/** 敏感文件（决定 4）：默认藏起来，打开要确认并留审计。只看文件名。 */
export function isSensitivePath(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  return SENSITIVE.some((pattern) => pattern.test(name));
}

const DIFF_SECTION_PREFIXES = ['diff --git ', 'diff --cc ', 'diff --combined '] as const;
const DIFF_META_PREFIXES = [
  ...DIFF_SECTION_PREFIXES,
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
  '--- ',
  '+++ '
] as const;

/** git 的 C 风格引号：`"a/sub/\303\274nicode.txt"`。 */
function decodeGitQuoted(raw: string): string {
  const bytes: number[] = [];
  let i = 1;
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') break;
    if (ch !== '\\') {
      const code = ch.codePointAt(0)!;
      for (const byte of new TextEncoder().encode(String.fromCodePoint(code))) bytes.push(byte);
      i += code > 0xffff ? 2 : 1;
      continue;
    }
    i += 1;
    const escaped = raw[i];
    if (escaped === undefined) break;
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]!);
      i += 1;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = '';
      while (octal.length < 3 && i < raw.length && /[0-7]/.test(raw[i]!)) {
        octal += raw[i];
        i += 1;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      continue;
    }
    bytes.push(escaped.charCodeAt(0));
    i += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** 把一行 diff 元数据拆成路径候选；未加引号的部分按空白拆，够 isSensitivePath 只看文件名。 */
function pathTokens(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      tokens.push(decodeGitQuoted(text.slice(i, Math.min(end + 1, text.length))));
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && !/\s/.test(text[end]!) && text[end] !== '"') end += 1;
    tokens.push(text.slice(i, end));
    i = end;
  }
  return tokens;
}

function diffMetaRest(line: string): string | null {
  for (const prefix of DIFF_META_PREFIXES) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/** 这一节 diff 是否碰到敏感文件：改名/复制的源和目标、`---`/`+++`、`Binary files`、`diff --git` 都算。 */
function sectionHasSensitivePath(section: readonly string[]): boolean {
  let inHunk = false;
  for (const line of section) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk) continue;
    const rest = diffMetaRest(line);
    if (rest !== null && pathTokens(rest).some((token) => isSensitivePath(token))) return true;
  }
  return false;
}

/**
 * 从 unified diff 里整段剔除敏感文件（#269）：`.env`、私钥等已跟踪文件的内容不能进整树 patch。
 * 改名 / 复制只要源或目标命中就整节丢弃；路径可能是 git 的 C 风格引号，先解码再按文件名判断。
 * 正常文件原样保留；引号 / 空格 / 非 ASCII 路径不影响判断。
 */
export function withoutSensitiveDiff(patch: string): string {
  if (patch === '') return '';
  // 旧 Worker 的未跟踪文件只以名字进 patch；名字本身敏感时整行去掉，别让路径漏出去。
  const lines = patch.split('\n').filter((line) => {
    const untracked = line.startsWith('新文件：') ? line.slice('新文件：'.length) : null;
    return untracked === null || !isSensitivePath(untracked);
  });
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DIFF_SECTION_PREFIXES.some((prefix) => lines[i]!.startsWith(prefix))) starts.push(i);
  }
  // 正常 git diff 一定有 diff --git 头；没有就整体保守判断，避免把拼不出来的内容当安全。
  if (starts.length === 0) return sectionHasSensitivePath(lines) ? '' : lines.join('\n');
  const kept: string[] = lines.slice(0, starts[0]!);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    const section = lines.slice(from, to);
    if (!sectionHasSensitivePath(section)) for (const line of section) kept.push(line);
  }
  return kept.join('\n');
}

/** `diff --git` 头允许的前缀组合：默认 a/ b/、mnemonic c/ w/、--no-index 1/ 2/，以及关掉前缀。 */
const HEADER_PREFIX_PAIRS = [
  ['a/', 'b/'],
  ['c/', 'w/'],
  ['1/', '2/'],
  ['', '']
] as const;

/** 只认 git 实际会写出的 C 风格引号：闭合引号必须在末尾，转义中间不能有裸引号。 */
function decodeHeaderQuoted(body: string): string | null {
  let i = 1;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '\\') {
      const escaped = body[i + 1];
      if (escaped === undefined) return null;
      i += /[0-7]/.test(escaped) ? 4 : 2;
      continue;
    }
    if (ch === '"') return i === body.length - 1 ? decodeGitQuoted(body) : null;
    i += ch.codePointAt(0)! > 0xffff ? 2 : 1;
  }
  return null;
}

/** 头一侧的正文：裸写原样返回；C 风格引号解开后返回（注意前缀在引号里面）。拼不出来返回 null。 */
function decodeHeaderBody(body: string): string | null {
  if (body === '') return null;
  if (!body.startsWith('"')) return body;
  return decodeHeaderQuoted(body);
}

/** 头里的路径正文是否就是这个文件。git 仅在路径含控制字符 / `"` / `\` 时加引号；空格和非 ASCII 都是裸的。 */
function headerBodyIsPath(body: string, path: string): boolean {
  return decodeHeaderBody(body) === path;
}

/**
 * `diff --git <左边> <右边>` 头是否只提到请求的这个字面量路径。先解开引号（引号把前缀也包在
 * 里面），两侧前缀还必须是已知组合，各去掉一层之后两段都必须逐字等于路径 —— 目录展开是更深
 * 的路径、glob 命中 / 改名是别的路径，都对不上。路径里可能有空格，不能按空白切，只能逐段
 * 试分隔点并解出正文。
 */
function headerIsPath(rest: string, path: string): boolean {
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] !== ' ') continue;
    const left = decodeHeaderBody(rest.slice(0, i));
    const right = decodeHeaderBody(rest.slice(i + 1));
    if (left === null || right === null) continue;
    for (const [from, to] of HEADER_PREFIX_PAIRS) {
      if (!left.startsWith(from) || !right.startsWith(to)) continue;
      // 已知前缀各去掉一层之后，两段都必须逐字等于请求的路径；不做任何任意的切分猜测。
      if (left.slice(from.length) === path && right.slice(to.length) === path) return true;
    }
  }
  return false;
}

/**
 * 单文件 diff 的输出身份：每个 section 头只能提到请求的这个字面量路径。
 * 适配器用字面量路径 + `--no-renames --src-prefix=a/ --dst-prefix=b/` 产出时，头必然是
 * `diff --git a/<path> b/<path>`（路径带空格时也是裸的，不加引号）；目录展开、glob 命中、
 * 改名 / 复制都会让它对不上。拼不出来（合并 diff、改名元数据、前缀不是已知组合）一律
 * false：宁可不显示，不猜。
 */
export function patchOnlyTouches(patch: string, path: string): boolean {
  if (patch === '') return true;
  const lines = patch.split('\n');
  let sections = 0;
  for (const line of lines) {
    // 单文件路径的 diff 不该出现合并 / 改名 / 复制元数据；出现了就说明拼不出准确路径。
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) return false;
    if (/^(rename|copy) (from|to) /.test(line)) return false;
    if (!line.startsWith('diff --git ')) continue;
    sections += 1;
    if (!headerIsPath(line.slice('diff --git '.length), path)) return false;
  }
  if (sections > 0) return true;
  // 没有 section 头：旧 Worker 只回一行「新文件：名字」；其余形态不认。
  return lines.every((line) => line === '' || (line.startsWith('新文件：') && headerBodyIsPath(line.slice('新文件：'.length), path)));
}

/** 前 8 KB 里有 NUL 就当二进制。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** 提交号只认 4–64 位十六进制（防止把参数塞进 git 命令）。 */
export const isCommitId = (value: string): boolean => /^[0-9a-f]{4,64}$/i.test(value);

/** 开放 API（MCP 工具 workspace_diff / workspace_read_file）的上限：整树 diff 与单文件读取都是 256 KiB。 */
export const OPEN_WORKSPACE_LIMITS = { diffBytes: 256 * 1024, fileBytes: 256 * 1024 } as const;
