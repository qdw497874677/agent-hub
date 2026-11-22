import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';

/** 连接凭据只供 Worker 使用，不能经继承环境传给 runtime 或任何其他子进程。 */
export function consumeWorkerCredentials(env: NodeJS.ProcessEnv) {
  const consume = (key: string): string => {
    const value = env[key] ?? '';
    delete env[key];
    return value;
  };
  return { token: consume('HUB_TOKEN'), credential: consume('HUB_WORKER_CREDENTIAL'), localSecret: consume('HUB_LOCAL_SECRET') };
}

/**
 * 把 worker.env 里的 HUB_WORKER_CREDENTIAL 换成新凭据（ADR 0030 D3 轮换）。
 * tmp + fsync + rename，权限沿用原文件（600）；文件不存在或没有那一行就返回 false（不新建，免得写错地方）。
 */
export function rewriteCredentialEnv(file: string, credential: string): boolean {
  if (!/^[A-Za-z0-9_\-.]+$/.test(credential)) return false;
  let text: string;
  let mode: number;
  try {
    text = readFileSync(file, 'utf8');
    mode = statSync(file).mode & 0o777;
  } catch {
    return false;
  }
  const line = /^HUB_WORKER_CREDENTIAL=.*$/m;
  if (!line.test(text)) return false;
  const next = text.replace(line, `HUB_WORKER_CREDENTIAL=${credential}`);
  const tmp = `${file}.rotate-${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, next);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return true;
}
