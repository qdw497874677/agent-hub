import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeInstants, localTime } from './local-time.ts';

test('文字里的 UTC 时刻换成本地时间；不带时区的、不是时刻的不碰', () => {
  const ms = Date.UTC(2026, 9, 28, 2, 5, 9, 120);
  assert.equal(localizeInstants('有效至 2026-10-28T02:05:09.120Z'), `有效至 ${localTime(ms)}`);
  assert.equal(localizeInstants('有效至 2026-10-28T10:05:09+08:00'), `有效至 ${localTime(ms - 120)}`);
  assert.equal(localizeInstants('上传技能 2026-10-28T02:05:09'), '上传技能 2026-10-28T02:05:09');
  assert.equal(localizeInstants('上传 MCP abc123'), '上传 MCP abc123');
});
