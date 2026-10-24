#!/usr/bin/env node
// 开发模式：server（自带 worker）+ vite，一个命令。Ctrl-C 一起退。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];

function run(label, command, args, cwd, color) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
