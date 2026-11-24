import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** 和 Worker 同一个 node 配套的 npm（npm-cli.js），找不到返回 null。PATH 里的 npm 按真实路径认。 */
export function findNpm(node: string, path: string = process.env['PATH'] ?? ''): string | null {
  const candidates = [join(dirname(node), 'npm'), join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const dir of path.split(delimiter).filter(Boolean)) candidates.push(join(dir, 'npm'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // 断链之类，看下一个
    }
  }
  return null;
}

/** 装好的包的 bin 入口（相对暂存目录），读包自己的 package.json，不猜路径。 */
export function npmBin(dir: string, pkg: string, command: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command];
  if (!bin || bin.includes('..')) throw new Error(`${pkg} 的 package.json 里没有 ${command} 入口`);
  return join('node_modules', pkg, bin.replace(/^\.\//, ''));
}
