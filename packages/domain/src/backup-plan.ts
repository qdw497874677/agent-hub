/**
 * hub 数据库备份计划（ADR 0030 D2）。纯函数：给磁盘余量和已有备份，决定能不能备、备完删哪些旧的。
 * 真正的 VACUUM INTO / integrity_check 在适配器（apps/server/src/backup.ts）里做。
 */
export const BACKUP_KEEP = 10;
export const BACKUP_MIN_FREE_BYTES = 512 * 1024 * 1024;

export interface BackupInput {
  readonly dbBytes: number;
  readonly walBytes: number;
  readonly freeBytes: number;
  /** 已有的备份文件（只认本工具写的命名）。 */
  readonly existing: readonly { readonly name: string; readonly mtimeMs: number }[];
  readonly keep?: number;
}

export type BackupPlan =
  | { readonly ok: false; readonly reason: 'disk'; readonly needBytes: number; readonly freeBytes: number }
  | { readonly ok: true; readonly needBytes: number; readonly prune: readonly string[] };

/** 至少要 2×(db+wal)，且不少于 512MB：备份本身要一份，VACUUM 的临时页还要一份。 */
export const backupNeedBytes = (dbBytes: number, walBytes: number): number => Math.max(2 * (dbBytes + walBytes), BACKUP_MIN_FREE_BYTES);

export function backupPlan(input: BackupInput): BackupPlan {
  const needBytes = backupNeedBytes(input.dbBytes, input.walBytes);
  if (input.freeBytes < needBytes) return { ok: false, reason: 'disk', needBytes, freeBytes: input.freeBytes };
  const keep = Math.max(1, input.keep ?? BACKUP_KEEP);
  // 新备份也算一份：留 keep-1 份旧的
  const sorted = [...input.existing].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return { ok: true, needBytes, prune: sorted.slice(keep - 1).map((entry) => entry.name) };
}

/** 本工具写的备份名：hub-YYYYMMDD-HHMMSS[-pre-<sha>].db。只清理这种，别碰人手放的文件。 */
export const BACKUP_NAME = /^hub-\d{8}-\d{6}(-pre-[0-9a-f]{7,40})?\.db$/;

export function backupName(at: Date, commit?: string | null): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const sha = commit && /^[0-9a-f]{7,40}$/.test(commit) ? `-pre-${commit.slice(0, 7)}` : '';
  return `hub-${stamp}${sha}.db`;
}
