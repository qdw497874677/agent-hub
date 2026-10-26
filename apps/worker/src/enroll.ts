import { enrollOverLink } from '@agent-hub/node-gateway';

/**
 * 一次性接入：`HUB_URL=ws://…/worker HUB_PAIR=… WORKER_LABEL=… node enroll.ts`
 * 经 /worker 长连接用配对码换专属凭据。成功时 stdout 两行：workerId、凭据（给安装脚本写进 env 文件）；
 * 失败原因只进 stderr。码和凭据只经环境变量 / 管道，不出现在命令行参数里。
 */
const url = process.env['HUB_URL'];
const code = process.env['HUB_PAIR'];
if (!url || !code) {
  console.error('需要 HUB_URL 和 HUB_PAIR');
  process.exit(2);
}
const outcome = await enrollOverLink({ url, code, label: process.env['WORKER_LABEL'] || 'worker' });
if (!outcome.ok) {
  console.error(`接入失败：${outcome.reason}`);
  process.exit(1);
}
process.stdout.write(`${outcome.workerId}\n${outcome.credential}\n`);
