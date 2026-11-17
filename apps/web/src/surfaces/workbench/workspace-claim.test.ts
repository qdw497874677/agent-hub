import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  claimOwnerLabel,
  claimViewFromTeamRow,
  groupWorkspaceChoices,
  transferBlockedReason,
  type ClaimChoiceView
} from './workspace-claim.ts';

const view = (workspaceId: string, ownerProjectId: string | null, ownerProjectName: string | null = null): ClaimChoiceView =>
  ({ workspaceId, ownerProjectId, ownerProjectName });

test('分组：未分配 / 本项目 / 别的项目，保持传入顺序', () => {
  const groups = groupWorkspaceChoices(
    [
      view('a', null),
      view('b', 'p1', '一号项目'),
      view('c', 'p2', '二号项目'),
      view('d', null),
      view('e', 'p1', '一号项目')
    ],
    'p1'
  );
  assert.deepEqual(groups.unassigned.map((v) => v.workspaceId), ['a', 'd']);
  assert.deepEqual(groups.mine.map((v) => v.workspaceId), ['b', 'e']);
  assert.deepEqual(groups.others.map((v) => v.workspaceId), ['c']);
});

test('分组：主人看不见的目录归「别的项目」，不算可分配', () => {
  const hidden: ClaimChoiceView = { workspaceId: 'h', ownerProjectId: null, ownerProjectName: null, ownerHidden: true };
  const groups = groupWorkspaceChoices([hidden, view('x', null)], 'p1');
  assert.deepEqual(groups.unassigned.map((v) => v.workspaceId), ['x']);
  assert.deepEqual(groups.others.map((v) => v.workspaceId), ['h']);
  assert.deepEqual(groups.mine, []);
});

test('分组：空列表三档都空', () => {
  assert.deepEqual(groupWorkspaceChoices([], 'p1'), { unassigned: [], mine: [], others: [] });
});

test('团队行 → 候选：只认第一个关联项目当主人', () => {
  assert.deepEqual(
    claimViewFromTeamRow({
      workspace: { id: 'w1' },
      projects: [{ id: 'p2', name: '二号项目' }, { id: 'p3', name: '三号项目' }],
      hiddenProjects: 0
    }),
    { workspaceId: 'w1', ownerProjectId: 'p2', ownerProjectName: '二号项目' }
  );
});

test('团队行 → 候选：一个项目都看不见但有 hiddenProjects，记成有主人', () => {
  const claim = claimViewFromTeamRow({
    workspace: { id: 'w2' },
    projects: [],
    hiddenProjects: 2
  });
  assert.equal(claim.ownerHidden, true);
  assert.equal(claim.ownerProjectId, null);
  assert.equal(claimOwnerLabel(claim), '你看不到的项目');
});

test('团队行 → 候选：没人关联 = 可分配', () => {
  assert.deepEqual(
    claimViewFromTeamRow({ workspace: { id: 'w3' }, projects: [], hiddenProjects: 0 }),
    { workspaceId: 'w3', ownerProjectId: null, ownerProjectName: null }
  );
});

test('主人名字为空时回退成「别的项目」', () => {
  assert.equal(claimOwnerLabel(view('w', 'p9', '  ')), '别的项目');
  assert.equal(claimOwnerLabel(view('w', 'p9', null)), '别的项目');
  assert.equal(claimOwnerLabel(view('w', 'p9', '九号项目')), '九号项目');
});

test('转移按钮：只有「别的项目看得见」时才放行', () => {
  assert.equal(transferBlockedReason(view('w', 'p2', '二号项目'), 'p1'), null);
  assert.match(transferBlockedReason(view('w', null), 'p1') ?? '', /还没分配/);
  assert.match(transferBlockedReason(view('w', 'p1', '一号项目'), 'p1') ?? '', /已经属于本项目/);
  assert.match(
    transferBlockedReason({ workspaceId: 'w', ownerProjectId: null, ownerProjectName: null, ownerHidden: true }, 'p1') ?? '',
    /看不到这个目录/
  );
});

test('组件里转移流程的 testid 还在（改文案别把它们弄丢了）', () => {
  const source = readFileSync(new URL('./link-workspaces.tsx', import.meta.url), 'utf8');
  for (const id of ['ws-link-open', 'ws-link', 'ws-link-one', 'ws-transfer', 'ws-transfer-confirm', 'ws-link-empty']) {
    assert.ok(source.includes(`data-testid="${id}"`), `缺少 data-testid="${id}"`);
  }
});
