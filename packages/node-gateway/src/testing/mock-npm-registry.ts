import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 本地假 npm registry（测试用）：现场 `npm pack` 出 tarball，提供 packument（/<name>、/<name>/<version>）和 tarball。
 * 组件安装器、hub 解析器、e2e 都用它，不连外网。
 */
export interface MockPackage {
  readonly name: string;
  readonly version: string;
  readonly scripts?: Record<string, string>;
  readonly files?: Record<string, string>;
}

export interface MockRegistry {
  readonly url: string;
  readonly integrity: (name: string, version: string) => string;
  readonly hits: string[];
  /** 换掉某个版本的 tarball 内容（模拟制品被篡改：哈希对不上）。 */
  readonly tamper: (name: string, version: string) => void;
  readonly close: () => Promise<void>;
}

export const npmCli = (): string => {
  const candidates = [join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const dir of (process.env['PATH'] ?? '').split(':').filter(Boolean)) candidates.push(join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('找不到 npm-cli.js');
  return found;
};

function pack(pkg: MockPackage, work: string): Buffer {
  const dir = mkdtempSync(join(work, 'pkg-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'index.js', ...(pkg.scripts ? { scripts: pkg.scripts } : {}) }));
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
  for (const [file, body] of Object.entries(pkg.files ?? {})) writeFileSync(join(dir, file), body);
  const out = join(dir, 'out');
  mkdirSync(out);
  const result = spawnSync(process.execPath, [npmCli(), 'pack', '--pack-destination', out, '--silent'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: dir } });
  if (result.status !== 0) throw new Error(`npm pack 失败：${result.stderr}`);
  return readFileSync(join(out, result.stdout.trim().split('\n').pop()!));
}

export async function startMockRegistry(packages: readonly MockPackage[], port = 0): Promise<MockRegistry> {
  const work = mkdtempSync(join(tmpdir(), 'mock-npm-'));
  const tarballs = new Map<string, Buffer>();
  const manifests = new Map<string, MockPackage>();
  for (const pkg of packages) {
    tarballs.set(`${pkg.name}@${pkg.version}`, pack(pkg, work));
    manifests.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const sri = (buf: Buffer) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;
  const integrity = new Map([...tarballs].map(([key, buf]) => [key, sri(buf)]));
  const hits: string[] = [];
  let base = '';
  const doc = (pkg: MockPackage) => ({
    name: pkg.name,
    version: pkg.version,
    ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
    dist: { tarball: `${base}/-/${encodeURIComponent(pkg.name)}-${pkg.version}.tgz`, integrity: integrity.get(`${pkg.name}@${pkg.version}`) }
  });
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    hits.push(path);
    const tgz = /^\/-\/(.+)-(\d[^/]*)\.tgz$/.exec(path);
    if (tgz) {
      const buf = tarballs.get(`${tgz[1]}@${tgz[2]}`);
      if (!buf) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(buf);
    }
    const [, name = '', version] = /^\/((?:@[^/]+\/)?[^/@]+)(?:\/([^/]+))?$/.exec(path) ?? [];
    const versions = [...manifests.values()].filter((p) => p.name === name);
    if (versions.length === 0) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
    res.setHeader('content-type', 'application/json');
    if (version) {
      const pkg = versions.find((p) => p.version === version);
      return void (pkg ? res.end(JSON.stringify(doc(pkg))) : res.writeHead(404).end('{}'));
    }
    const latest = versions[versions.length - 1]!;
    res.end(JSON.stringify({ name, 'dist-tags': { latest: latest.version }, versions: Object.fromEntries(versions.map((p) => [p.version, doc(p)])) }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  return {
    url: base,
    hits,
    integrity: (name, version) => integrity.get(`${name}@${version}`) ?? '',
    tamper: (name, version) => {
      const pkg = manifests.get(`${name}@${version}`)!;
      const buf = pack({ ...pkg, files: { ...pkg.files, 'tampered.js': '// x\n' } }, work);
      tarballs.set(`${name}@${version}`, buf);
      integrity.set(`${name}@${version}`, sri(buf));
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
