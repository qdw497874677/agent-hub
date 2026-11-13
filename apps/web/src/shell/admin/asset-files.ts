import { unzipSync } from 'fflate';

/**
 * 把浏览器里挑的东西（一堆文件、一个文件夹、一个 zip）变成「相对技能根目录的路径 → 内容」。
 * 规则：去掉系统垃圾；所有文件都在同一个顶层目录下时剥掉这一层（拖文件夹 / 打包整个目录的常见情况）。
 * 不做安全判断——那是服务端的事。
 */
export type PickedFile = { readonly path: string; readonly bytes: Uint8Array };

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/;

export function tidy(files: readonly PickedFile[]): PickedFile[] {
  const kept = files
    .map((file) => ({ ...file, path: file.path.replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((file) => file.path !== '' && !file.path.endsWith('/') && !JUNK.test(file.path));
  const tops = new Set(kept.map((file) => (file.path.includes('/') ? file.path.split('/')[0] : '')));
  if (kept.length > 0 && tops.size === 1 && !tops.has('')) {
    const prefix = `${[...tops][0]}/`;
    return kept.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
  }
  return kept;
}

export function unzip(bytes: Uint8Array): PickedFile[] {
  return Object.entries(unzipSync(bytes)).map(([path, data]) => ({ path, bytes: data }));
}

export async function readPicked(list: ArrayLike<File>): Promise<PickedFile[]> {
  const files = Array.from(list);
  if (files.length === 1 && /\.zip$/i.test(files[0]!.name)) {
    return tidy(unzip(new Uint8Array(await files[0]!.arrayBuffer())));
  }
  const picked = await Promise.all(
    files.map(async (file) => ({
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer())
    }))
  );
  return tidy(picked);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export const encodeFiles = (files: readonly PickedFile[]) => files.map((file) => ({ path: file.path, data: toBase64(file.bytes) }));

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
