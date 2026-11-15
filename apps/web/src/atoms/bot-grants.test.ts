import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_GRANT_PICKER_EMPTY, BOT_GRANT_WORKSPACE_DEFAULT, BOT_GRANTS_EMPTY,
  grantCandidates, grantPickerView, grantRevokeConfirm, grantRowView, grantedWorkspaceText, projectGrant
} from './bot-grants.ts';

const bot = (id: string) => ({ id });

test('过滤候选：只列团队里还没授权到本项目的 bot', () => {
  const team = [bot('bot_a'), bot('bot_b'), bot('bot_c')];
  assert.deepEqual(grantCandidates(team, ['bot_b']).map((b) => b.id), ['bot_a', 'bot_c']);
  assert.deepEqual(grantCandidates(team, ['bot_a', 'bot_b', 'bot_c']), []);
});

test('过滤候选：保留团队列表顺序（不按字母或授权时间重排）', () => {
  const team = [bot('bot_z'), bot('bot_a'), bot('bot_m')];
  assert.deepEqual(grantCandidates(team, []).map((b) => b.id), ['bot_z', 'bot_a', 'bot_m']);
  // 已经授权的是中间那个，顺序也不能塌
  assert.deepEqual(grantCandidates(team, ['bot_a']).map((b) => b.id), ['bot_z', 'bot_m']);
});

test('选择浮层空态：团队 bot 全授权了才给空态，加载中不抢先下结论', () => {
  const team = [bot('bot_a')];
  assert.deepEqual(grantPickerView(team, ['bot_a']), { items: [], empty: BOT_GRANT_PICKER_EMPTY });
  assert.deepEqual(grantPickerView(team, ['bot_a'], true), { items: [], empty: null });
  assert.deepEqual(grantPickerView([], [], false), { items: [], empty: BOT_GRANT_PICKER_EMPTY });
  // 还有候选就不给空态
  assert.equal(grantPickerView(team, [], true).empty, null);
  assert.deepEqual(grantPickerView(team, []).items.map((b) => b.id), ['bot_a']);
  // 一个授权都没有时的授权段空态文案
  assert.equal(BOT_GRANTS_EMPTY, '还没授权到任何项目。');
});

test('能否撤销：只有本项目上的那条授权能撤销', () => {
  const grants = [
    { botId: 'bot_a', projectId: 'p_1', workspaceId: null, createdAt: 1, createdBy: null },
    { botId: 'bot_a', projectId: 'p_2', workspaceId: 'w_1', createdAt: 2, createdBy: 'u_1' }
  ];
  assert.equal(projectGrant(grants, 'p_1')?.projectId, 'p_1');
  assert.equal(projectGrant(grants, 'p_9'), null);
  assert.equal(projectGrant([], 'p_1'), null);
});

test('工作目录名称兜底：null 说跟随项目默认，查不到就说 id', () => {
  const names = new Map([['w_1', '主仓库']]);
  assert.equal(grantedWorkspaceText(null, names), BOT_GRANT_WORKSPACE_DEFAULT);
  assert.equal(BOT_GRANT_WORKSPACE_DEFAULT, '工作目录：跟随项目默认');
  assert.equal(grantedWorkspaceText('w_1', names), '工作目录：主仓库');
  assert.equal(grantedWorkspaceText('w_gone', names), '工作目录：w_gone');
  const empty = new Map<string, string>();
  assert.equal(grantedWorkspaceText('w_1', empty), '工作目录：w_1');
});

test('授权行文案：项目名缺了就退回项目 id', () => {
  const names = new Map([['w_1', '主仓库']]);
  assert.deepEqual(grantRowView({ projectId: 'p_1', workspaceId: 'w_1' }, '编译器', names), {
    project: '编译器',
    workspace: '工作目录：主仓库'
  });
  assert.deepEqual(grantRowView({ projectId: 'p_1', workspaceId: null }, null, names), {
    project: 'p_1',
    workspace: BOT_GRANT_WORKSPACE_DEFAULT
  });
  assert.equal(grantRowView({ projectId: 'p_1', workspaceId: null }, '   ', names).project, 'p_1');
});

test('撤销确认文案：点名 bot 和项目，并说清会从群里移出、记录保留', () => {
  const text = grantRevokeConfirm('代码审查', '编译器');
  assert.equal(
    text,
    '撤销「代码审查」在「编译器」的授权？它会从本项目的群里移出，@ 它也不再响应；已有的会话和聊天记录会保留。'
  );
  assert.ok(text.includes('移出'));
  assert.ok(text.includes('保留'));
});
