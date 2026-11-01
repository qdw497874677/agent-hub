import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 自更新的「待验证」标记（格式和 scripts/worker-boot-guard.sh 约定好：`<原提交> <目标提交> <启动次数>`）。
 * 更新成功、退出重启前写上；新版本健康后删掉。没删掉就重启太多次，守卫脚本会回滚。
 */
export function bootMarkerPath(stateDir: string): string {
  return join(stateDir, 'update-pending');
}

export function writeBootMarker(stateDir: string, previous: string, target: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(bootMarkerPath(stateDir), `${previous} ${target} 0\n`);
}

/** 返回 true 表示确实有一个待验证的更新刚被确认健康。 */
export function clearBootMarker(stateDir: string): boolean {
  const path = bootMarkerPath(stateDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * 回退记录（scripts/worker-boot-guard.sh 回滚后写）：第一行 `<坏的新提交> <换回的旧提交>`，之后是原因。
 * Worker 用旧版连上 hub 后读出来报给 hub（状态 rolled_back），报完删掉。
 */
export function rollbackNotePath(stateDir: string): string {
  return join(stateDir, 'update-rolledback');
}

export interface RollbackNote {
  readonly failed: string;
  readonly restored: string;
  readonly reason: string;
}

export function readRollbackNote(stateDir: string): RollbackNote | null {
  const path = rollbackNotePath(stateDir);
  if (!existsSync(path)) return null;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const [head = '', ...rest] = text.split('\n');
  const [failed = '', restored = ''] = head.trim().split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(failed) || !/^[0-9a-f]{40}$/.test(restored)) {
    rmSync(path, { force: true });
    return null;
  }
  return { failed, restored, reason: rest.join('\n').trim().slice(-3500) };
}

export function clearRollbackNote(stateDir: string): void {
  rmSync(rollbackNotePath(stateDir), { force: true });
}

/** 回退记录 → 报给 hub 的更新状态。 */
export function rollbackReport(note: RollbackNote): { state: 'rolled_back'; message: string; logTail: string } {
  return {
    state: 'rolled_back',
    message: `新版本 ${note.failed.slice(0, 7)} 没能正常启动，已自动回退到 ${note.restored.slice(0, 7)}`,
    logTail: note.reason
  };
}
