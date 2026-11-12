#!/usr/bin/env node
// 开发模式：server（自带 worker）+ vite，一个命令。Ctrl-C 一起退。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];

// 端口解析与 vite.config.ts 保持一致：HUB_PORT 默认 7878，WEB_PORT 默认 5173。
function resolvePort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    console.error(`[dev] ${name}=${JSON.stringify(raw)} 不是合法端口`);
    process.exit(1);
  }
  return raw;
}

const hubPort = resolvePort('HUB_PORT', '7878');
const webPort = resolvePort('WEB_PORT', '5173');

// vite 用 `process.env.HUB_PORT ?? '7878'` 取代理目标；这里用同样的表达式回读，
// 不一致（例如空字符串被这里归一化）就立刻退出，防止前端静默打向另一个端口。
const viteHubPort = process.env.HUB_PORT ?? '7878';
if (viteHubPort !== hubPort) {
  console.error(
    `[dev] HUB_PORT 不一致：dev.mjs 解析为 ${JSON.stringify(hubPort)}，vite 会读到 ${JSON.stringify(viteHubPort)}`
  );
  process.exit(1);
}

console.log(`hub=http://127.0.0.1:${hubPort} web=http://127.0.0.1:${webPort}`);

const childEnv = { ...process.env, HUB_PORT: hubPort, WEB_PORT: webPort };

function run(label, command, args, cwd, color) {
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const tag = `\u001b[${color}m${label}\u001b[0m`;
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr]
  ]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') sink.write(`${tag} ${line}\n`);
      }
    });
  }
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${tag} 退出，code ${code}`);
      shutdown();
    }
  });
  return child;
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('hub   ', process.execPath, [join(root, 'apps/server/src/main.ts')], root, '33');
run('web   ', 'npx', ['vite', '--host', '127.0.0.1'], join(root, 'apps/web'), '36');
