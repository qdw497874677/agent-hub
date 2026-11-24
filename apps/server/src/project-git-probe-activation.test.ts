import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_GIT_PROBE_SECRETS_TABLE, setupProjectGitProbe } from './project-git-probe-activation.ts';

const ENABLED_ENV = {
  HUB_PROJECT_GIT_PROBE_ORIGINS: ' https://git.example.com , https://other.example.com ',
  HUB_PROJECT_GIT_PROBE_PROJECTS: 'p1, p2 '
};
const env = (values: Record<string, string>) => (name: string) => values[name] ?? null;

async function privateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'probe-activation-'));
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

test('默认关闭：没配环境变量时不读数据目录、不建隔离密钥表', async () => {
  const dir = await privateDir();
  const warnings: string[] = [];
  try {
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env({}), spawnWorker: '0', dataDir: dir, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.deepEqual(warnings, []);
    assert.equal(tableExists(db, PROJECT_GIT_PROBE_SECRETS_TABLE), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnWorker 不是 0 时不启用（旧的 Worker Git 路径不认识专用密钥名）', async () => {
  const dir = await privateDir();
  const warnings: string[] = [];
  try {
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env(ENABLED_ENV), spawnWorker: '1', dataDir: dir, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.deepEqual(warnings, []);
    assert.equal(tableExists(db, PROJECT_GIT_PROBE_SECRETS_TABLE), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('白名单缺一半时不启用，也不提示目录问题', async () => {
  const dir = await privateDir();
  const warnings: string[] = [];
  try {
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env({ HUB_PROJECT_GIT_PROBE_ORIGINS: 'https://git.example.com' }),
      spawnWorker: '0', dataDir: dir, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.deepEqual(warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据目录有组/其他权限时保持关闭并提示', async () => {
  const dir = await privateDir();
  const warnings: string[] = [];
  try {
    await chmod(dir, 0o755);
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env(ENABLED_ENV), spawnWorker: '0', dataDir: dir, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /已保持关闭/);
    assert.match(warnings[0]!, new RegExp(dir.replaceAll('/', '\\/')));
    assert.equal(tableExists(db, PROJECT_GIT_PROBE_SECRETS_TABLE), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据目录是符号链接时保持关闭', async () => {
  const dir = await privateDir();
  const parent = await privateDir();
  const warnings: string[] = [];
  try {
    const link = join(parent, 'link');
    await symlink(dir, link);
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env(ENABLED_ENV), spawnWorker: '0', dataDir: link, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('数据目录不存在时保持关闭', async () => {
  const parent = await privateDir();
  const missing = join(parent, 'missing');
  const warnings: string[] = [];
  try {
    const db = new DatabaseSync(':memory:');
    const activation = await setupProjectGitProbe({
      readEnv: env(ENABLED_ENV), spawnWorker: '0', dataDir: missing, db, secretKey: randomBytes(32), warn: (m) => warnings.push(m)
    });
    assert.equal(activation, null);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('0700 数据目录 + 显式白名单：启用，白名单精确匹配，密钥独立分表', async () => {
  const dir = await privateDir();
  const warnings: string[] = [];
  try {
    const db = new DatabaseSync(':memory:');
    const secretKey = randomBytes(32);
    const activation = await setupProjectGitProbe({
      readEnv: env(ENABLED_ENV), spawnWorker: '0', dataDir: dir, db, secretKey, warn: (m) => warnings.push(m)
    });
    assert.ok(activation);
    assert.deepEqual(warnings, []);
    assert.equal(activation.allows('p1', 'repo', 'https://git.example.com/org/repo.git'), true);
    assert.equal(activation.allows('p2', 'repo', 'https://other.example.com/org/repo.git'), true);
    assert.equal(activation.allows('p1', 'repo', 'https://git.example.com:443/org/repo.git?x=1'), true);
    assert.equal(activation.allows('p3', 'repo', 'https://git.example.com/org/repo.git'), false);
    assert.equal(activation.allows('p1', 'repo', 'https://evil.example.com/org/repo.git'), false);

    // 隔离凭据只落专用表，不和资产 / 普通项目令牌混用。
    assert.equal(tableExists(db, PROJECT_GIT_PROBE_SECRETS_TABLE), true);
    assert.equal(tableExists(db, 'asset_secrets'), false);
    await activation.vault.put('repo-git-hub:p1:repo', 'token', 1);
    assert.deepEqual(await activation.vault.reveal(['repo-git-hub:p1:repo']), { 'repo-git-hub:p1:repo': 'token' });
    const names = db.prepare(`SELECT name FROM ${PROJECT_GIT_PROBE_SECRETS_TABLE}`).all() as Array<{ name: string }>;
    assert.deepEqual(names.map((row) => row.name), ['repo-git-hub:p1:repo']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
