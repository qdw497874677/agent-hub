import { writeFileSync } from 'node:fs';
import { RUN_FILE } from './run-id.ts';

/** 整个 run 共用一个 id：见 run-id.ts 里为什么不能用模块级 Date.now()。 */
export default function globalSetup(): void {
  writeFileSync(RUN_FILE, Date.now().toString(36));
}
