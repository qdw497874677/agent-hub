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
  requestsPerSecond: 20
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

/** 前 8 KB 里有 NUL 就当二进制。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** 提交号只认 4–64 位十六进制（防止把参数塞进 git 命令）。 */
export const isCommitId = (value: string): boolean => /^[0-9a-f]{4,64}$/i.test(value);
