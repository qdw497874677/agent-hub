import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLinkCandidates, type WorkspaceOwner } from './preview-autolink.ts';
import type { PreviewLink, PreviewLinkId, SessionId } from '@agent-hub/domain';

const link = (sessionId: string, workerId: string, port: number, id: string): PreviewLink => ({
  id: id as PreviewLinkId,
  sessionId: sessionId as SessionId,
  workerId,
  port,
  hubPort: 17900 + port % 100,
  label: `端口 ${port}`,
  source: 'detected',
  state: 'ready',
  createdAt: 1,
  lastSeenAt: 1
});

const owner = (sessionId: string, path: string, workerId = 'w1'): WorkspaceOwner => ({ sessionId, path, workerId });

test('自动发现：端口在听且 cwd 落在会话工作目录里，才出候选', () => {
  const owners = [owner('s1', '/work/app')];
  const got = autoLinkCandidates(
    [
      { pid: 1, cwd: '/work/app/packages/web', ports: [8130] },
      { pid: 2, cwd: '/work/app-other', ports: [8131] },
      { pid: 3, cwd: '/work/app', ports: [80] }
    ],
    owners
  );
  assert.deepEqual(got, [{ sessionId: 's1', workerId: 'w1', port: 8130 }]);
});

test('自动发现：已有链接（同机器同端口）不再重复，人工建的也算', () => {
  const got = autoLinkCandidates(
    [{ pid: 1, cwd: '/work/app', ports: [8130, 8131] }],
    [owner('s1', '/work/app')],
    { links: [link('s1', 'w1', 8130, 'pv_00000001')] }
  );
  assert.deepEqual(got, [{ sessionId: 's1', workerId: 'w1', port: 8131 }]);
});

test('自动发现：同一会话最多 8 条（已占用的会先计入）', () => {
  const links = Array.from({ length: 7 }, (_, index) => link('s1', 'w1', 9000 + index, `pv_0000000${index}`));
  const got = autoLinkCandidates(
    [{ pid: 1, cwd: '/work/app', ports: [9100, 9101, 9102] }],
    [owner('s1', '/work/app')],
    { links }
  );
  assert.deepEqual(got, [{ sessionId: 's1', workerId: 'w1', port: 9100 }]);
});

test('自动发现：最深的工作目录赢，不同机器不串', () => {
  const owners = [owner('root', '/work'), owner('deep', '/work/app', 'w2')];
  const got = autoLinkCandidates(
    [
      { pid: 1, cwd: '/work/app/x', ports: [7000] },
      { pid: 2, cwd: '/work/other', ports: [7001] }
    ],
    owners
  );
  assert.deepEqual(got, [
    { sessionId: 'deep', workerId: 'w2', port: 7000 },
    { sessionId: 'root', workerId: 'w1', port: 7001 }
  ]);
});

test('自动发现：allowedSessions 之外的会话不挂', () => {
  const got = autoLinkCandidates(
    [{ pid: 1, cwd: '/work/app', ports: [7000] }],
    [owner('s1', '/work/app')],
    { allowedSessions: new Set(['s2']) }
  );
  assert.deepEqual(got, []);
});
