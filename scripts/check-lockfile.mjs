#!/usr/bin/env node
// lockfile 一致性门禁：npm ci 会先清空 node_modules，半途缺包等于服务停摆。
// 规则：
//   1. package.json 的每个 workspace 在 package-lock.json 的 packages 里都有
//      node_modules/<name> 且 link: true；
//   2. lock 里所有 node_modules/@agent-hub/* 条目都有对应 workspace（防止 stale 条目）。
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url).pathname;

/** 把 workspaces 模式（`packages/*`、`apps/*`）展开成实际目录；只支持单层 `*`。 */
async function expandWorkspaceDirs(root, patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    const parts = pattern.split('/').filter(Boolean);
    const wildcard = parts.indexOf('*');
    if (wildcard === -1) {
      dirs.add(join(root, ...parts));
      continue;
    }
    if (parts.indexOf('*', wildcard + 1) !== -1) {
      throw new Error(`不支持的 workspace 模式（只允许单层 *）：${pattern}`);
    }
    const base = join(root, ...parts.slice(0, wildcard));
    const rest = parts.slice(wildcard + 1);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(join(base, entry.name, ...rest));
    }
  }
  return [...dirs];
}

/** 列出 workspace 包：{ name, dir }。没有 package.json 的目录（如 packages/adapters）跳过。 */
async function listWorkspaces(root, patterns) {
  const workspaces = [];
  const failures = [];
  for (const dir of await expandWorkspaceDirs(root, patterns)) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    } catch (error) {
      // 容器目录（本身不是包）没有 package.json 是正常的，只有拿到 ENOENT 才跳过。
      if (error.code === 'ENOENT') continue;
      failures.push(`${relative(root, dir)}/package.json: 无法读取或解析（${error.message}）`);
      continue;
    }
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      failures.push(`${relative(root, dir)}/package.json: 缺少 name`);
      continue;
    }
    workspaces.push({ name: pkg.name, dir: relative(root, dir) });
  }
  return { workspaces, failures };
}

/**
 * 检查 lockfile 与 workspace 的一致性。返回失败信息数组；空数组表示通过。
 * root 下需要 package.json 与 package-lock.json。
 */
export async function checkLockfile(root = ROOT) {
  const failures = [];

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch (error) {
    return { failures: [`package.json: 无法读取或解析（${error.message}）`], workspaces: 0 };
  }
  let lock;
  try {
    lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  } catch (error) {
    return { failures: [`package-lock.json: 无法读取或解析（${error.message}）`], workspaces: 0 };
  }

  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  if (patterns.length === 0) failures.push('package.json: workspaces 为空或缺失');

  let listed;
  try {
    listed = await listWorkspaces(root, patterns);
  } catch (error) {
    return { failures: [...failures, `workspaces: 无法展开（${error.message}）`], workspaces: 0 };
  }
  failures.push(...listed.failures);
  const { workspaces } = listed;
  const packages = lock.packages ?? {};
  const names = new Set(workspaces.map((workspace) => workspace.name));

  const missing = [];
  for (const { name, dir } of workspaces) {
    const key = `node_modules/${name}`;
    const entry = packages[key];
    if (!entry) missing.push(`${name}（${dir}）`);
    else if (entry.link !== true) failures.push(`${key}: 存在但不是 link: true（resolved=${entry.resolved ?? '?'}）`);
  }
  for (const name of missing) {
    failures.push(`lockfile 缺少 workspace 条目 node_modules/${name}`);
  }

  const stale = [];
  for (const key of Object.keys(packages)) {
    if (!key.startsWith('node_modules/@agent-hub/')) continue;
    const name = key.slice('node_modules/'.length);
    // 只检查顶层条目；嵌套的 node_modules/.../node_modules/... 不归这里管。
    if (name.split('/').length !== 2) continue;
    if (!names.has(name)) stale.push(name);
  }
  for (const name of stale) {
    failures.push(`lockfile 有 stale 条目 node_modules/${name}，但没有对应 workspace`);
  }

  return { failures, workspaces: workspaces.length };
}

export function reportLockfile({ failures, workspaces }) {
  if (failures.length > 0) {
    console.error('✗ lockfile 失败：\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log(`lockfile ok: ${workspaces} workspaces`);
}

// 仅在直接执行时跑全仓检查；被 import（比如 check-selftest.mjs）时只暴露函数。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  reportLockfile(await checkLockfile(ROOT));
}
