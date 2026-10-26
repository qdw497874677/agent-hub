import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
