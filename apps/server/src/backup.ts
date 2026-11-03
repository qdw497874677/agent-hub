import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_NAME, backupName, backupPlan } from '@agent-hub/domain';

/**
 * `main.ts backup [--keep N] [--dir D]`（ADR 0030 D2）：部署前给 hub.db 拍快照。
 * 退出码：0 成功；3 磁盘不够（什么都没写）；4 快照没过 integrity_check（坏快照已删）；1 其它错误。
 * 结果一行 JSON 打到 stdout，给 deploy-hub.sh 解析。
 */
export interface BackupResult {
  readonly code: 0 | 1 | 3 | 4;
  readonly report: Record<string, unknown>;
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

export function runBackup(options: { dataDir: string; dir?: string; keep?: number; commit?: string | null; now?: Date }): BackupResult {
  const db = join(options.dataDir, 'hub.db');
  const dir = options.dir ?? join(options.dataDir, '..', 'backups');
  try {
    mkdirSync(dir, { recursive: true });
    const fs = statfsSync(dir);
    const existing = readdirSync(dir)
      .filter((name) => BACKUP_NAME.test(name))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
    const plan = backupPlan({ dbBytes: sizeOf(db), walBytes: sizeOf(`${db}-wal`), freeBytes: fs.bavail * fs.bsize, existing, ...(options.keep ? { keep: options.keep } : {}) });
    if (!plan.ok) return { code: 3, report: { ok: false, reason: 'disk', needBytes: plan.needBytes, freeBytes: plan.freeBytes } };
    const out = join(dir, backupName(options.now ?? new Date(), options.commit));
    const source = new DatabaseSync(db, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(out, { readOnly: true });
    let integrity: string;
    try {
      integrity = String((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: unknown }).integrity_check);
    } finally {
      copy.close();
    }
    if (integrity !== 'ok') {
      rmSync(out, { force: true });
      return { code: 4, report: { ok: false, reason: 'integrity', integrity } };
    }
    for (const name of plan.prune) rmSync(join(dir, name), { force: true });
    return { code: 0, report: { ok: true, path: out, bytes: sizeOf(out), integrity, pruned: plan.prune } };
  } catch (error) {
    return { code: 1, report: { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** 解析 `backup` 之后的参数。 */
export function backupArgs(argv: readonly string[]): { keep?: number; dir?: string } {
  const out: { keep?: number; dir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep' && argv[i + 1]) out.keep = Math.max(1, Number.parseInt(argv[++i]!, 10) || 10);
    else if (argv[i] === '--dir' && argv[i + 1]) out.dir = argv[++i]!;
  }
  return out;
}
