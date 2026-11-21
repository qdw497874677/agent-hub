import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { AuditEntry } from '../account.ts';
import { asAgentId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { GitHostApi, PullRequestLink, PullRequestRepository, GitHostTokenStore } from '../ports/pull-requests.ts';
import type { RemotePullRequest } from '../ports/workspace-git.ts';
import { cleanBranchName, compareUrl, githubRepoOf, parseGitText, templateGitText } from '../git-workflow.ts';
import { newWorkspace } from '../workspace.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createGitWorkflowService } from './git-workflow.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

function memoryPrs(): PullRequestRepository & { rows: PullRequestLink[] } {
  const rows: PullRequestLink[] = [];
  return {
    rows,
    save: async (link) => {
      const i = rows.findIndex((r) => r.id === link.id);
      if (i >= 0) rows[i] = link;
      else rows.push(link);
    },
    byTask: async (taskId) => rows.filter((r) => r.taskId === taskId),
    byWorkspace: async (id) => rows.filter((r) => r.workspaceId === id),
    openSyncedBefore: async (cutoff, limit) => rows.filter((r) => r.state === 'open' && r.lastSyncedAt < cutoff).slice(0, limit)
  };
}

function memoryTokens(): GitHostTokenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    status: async (team) => ({ configured: map.has(team), last4: map.get(team)?.slice(-4) ?? null, updatedAt: map.has(team) ? 1 : null }),
    put: async (team, token) => void map.set(team, token),
    remove: async (team) => map.delete(team),
    reveal: async (team) => map.get(team) ?? null
  };
}

async function world(opts: { token?: boolean; host?: Partial<GitHostApi>; writer?: boolean } = {}) {
  const w = inMemoryDeps({ now: () => 1000 });
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo/' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '修登录' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const audits: AuditEntry[] = [];
  const prs = memoryPrs();
  const tokens = memoryTokens();
  if (opts.token) tokens.map.set('team-1', 'ghp_secretsecretsecret1234');
  const hostCalls: string[] = [];
  const listedPrs: { repo: string; head: string; pr: RemotePullRequest }[] = [];
  let clock = 1000;
  const svc = createGitWorkflowService({
    ...w.deps,
    audit: { append: async (e) => void audits.push(e) },
    workLog: w.deps.workLog,
    git: w.git.on('local'),
    pullRequests: prs,
    tokens,
    host: {
      createPullRequest: async (input) => (hostCalls.push(`create:${input.repo}:${input.head}->${input.base}:${input.token.slice(-4)}`), { ok: true, pr: { number: 7, url: `https://github.com/${input.repo}/pull/7`, state: 'open', headSha: 'abc', mergedAt: null } }),
      getPullRequest: async (input) => (hostCalls.push(`get:${input.number}`), { ok: true, pr: { number: input.number, url: `https://github.com/${input.repo}/pull/${input.number}`, state: 'merged', headSha: 'abc', mergedAt: 5 } }),
      listPullRequestsByHead: async (input) => {
        hostCalls.push(`list:${input.repo}:${input.head}:${input.token.slice(-4)}`);
        return { ok: true, prs: listedPrs.filter((e) => e.repo === input.repo && e.head === input.head).map((e) => e.pr) };
      },
      ...opts.host
    },
    ...(opts.writer ? { writer: { write: async () => ({ message: 'feat: 模型写的', title: '模型标题', body: '模型描述', branch: 'feat/model' }) } } : {}),
    hubTeamId: async () => 'team-1',
    now: () => clock
  });
  const root = '/tmp/demo';
  return { ...w, svc, audits, prs, tokens, hostCalls, listedPrs, session: session.value, task: task.value, root, tick: (ms: number) => (clock += ms) };
}

const dirty = (branch: string, remoteUrl: string | null, head = 'h0', defaultBranch: string | null = 'main') => ({
  isGit: true, branch, defaultBranch, remoteUrl, upstream: null, ahead: 0, head,
  files: [{ path: 'src/login.ts', status: 'M' }, { path: 'new.txt', status: '??' }], patch: 'diff --git a/src/login.ts', truncated: false
});

test('纯函数：GitHub 仓库识别 / 链接 / 模板 / 分支名 / 解析', () => {
  assert.equal(githubRepoOf('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubRepoOf('git@github.com:o/r.git'), 'o/r');
  assert.equal(githubRepoOf('ssh://git@github.com/o/r'), 'o/r');
  assert.equal(githubRepoOf('https://gitlab.com/o/r.git'), null);
  assert.equal(githubRepoOf(null), null);
  assert.equal(compareUrl('o/r', 'main', 'feat/x'), 'https://github.com/o/r/compare/main...feat%2Fx?expand=1');
  const t = templateGitText({ taskTitle: '修登录', files: [{ path: 'a.ts', status: 'M' }], workLog: '' });
  assert.ok(t.message.includes('修登录'));
  assert.ok(t.title.length > 0);
  assert.equal(t.branch, null);
  assert.equal(cleanBranchName('feat/fix-login'), 'feat/fix-login');
  assert.equal(cleanBranchName('Feat: 修 登录!!'), null);
  assert.equal(cleanBranchName('a b:c?d'), null);
  assert.equal(parseGitText('不是 JSON'), null);
});

test('状态：没 origin 不能开 PR；默认分支上不能开 PR；功能分支 + GitHub 可以', async () => {
  const w = await world();
  w.git.previews.set(w.root, dirty('main', null));
  let s = await w.svc.state(null, w.session.id);
  assert.ok(s.ok);
  assert.equal(s.value.files.length, 2);
  assert.match(s.value.prBlocked ?? '', /origin/);
  w.git.previews.set(w.root, dirty('main', 'https://github.com/o/r.git'));
  s = await w.svc.state(null, w.session.id);
  assert.ok(s.ok);
  assert.match(s.value.prBlocked ?? '', /默认分支/);
  w.git.previews.set(w.root, dirty('feat/x', 'https://gitlab.com/o/r.git'));
  s = await w.svc.state(null, w.session.id);
  assert.ok(s.ok && /GitHub/.test(s.value.prBlocked ?? ''));
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  s = await w.svc.state(null, w.session.id);
  assert.ok(s.ok);
  assert.equal(s.value.prBlocked, null);
  assert.equal(s.value.repo, 'o/r');
  assert.equal(s.value.prVia, 'gh');
});

test('起草：有模型用模型，没有用模板', async () => {
  const w = await world({ writer: true });
  w.git.previews.set(w.root, dirty('feat/x', null));
  const d = await w.svc.draft(null, w.session.id);
  assert.ok(d.ok);
  assert.equal(d.value.source, 'model');
  assert.equal(d.value.title, '模型标题');
  const plain = await world();
  plain.git.previews.set(plain.root, dirty('feat/x', null));
  const t = await plain.svc.draft(null, plain.session.id);
  assert.ok(t.ok);
  assert.equal(t.value.source, 'template');
});

test('提交：要说明；没改动拒绝；写审计', async () => {
  const w = await world();
  w.git.previews.set(w.root, dirty('feat/x', null));
  const empty = await w.svc.run(null, w.session.id, { action: 'commit', message: '  ' });
  assert.ok(!empty.ok);
  const r = await w.svc.run(null, w.session.id, { action: 'commit', message: 'fix: 登录' });
  assert.ok(r.ok);
  assert.equal(r.value.committed, true);
  assert.equal(r.value.pushed, false);
  assert.ok(w.audits.some((a) => a.action === 'git.commit'));
  const again = await w.svc.run(null, w.session.id, { action: 'commit', message: 'x' });
  assert.ok(!again.ok);
  // 没 origin 推不了
  const push = await w.svc.run(null, w.session.id, { action: 'push', message: '' });
  assert.ok(!push.ok);
});

test('敏感文件改动仍进入 Git 工作流状态与提交门槛（#269）', async () => {
  const w = await world();
  const sensitive = {
    ...dirty('feat/x', null),
    files: [{ path: '.env', status: 'M' }],
    patch: 'diff --git a/.env b/.env\n+SECRET=not-real-269'
  };
  w.git.previews.set(w.root, sensitive);
  const state = await w.svc.state(null, w.session.id);
  assert.ok(state.ok);
  assert.deepEqual(state.value.files, sensitive.files);
  const commit = await w.svc.run(null, w.session.id, { action: 'commit', message: 'fix: 保留敏感改动' });
  assert.ok(commit.ok);
  assert.equal(commit.value.committed, true);
});

test('开 PR：团队 token 优先；记工作日志、审计；同步拿到合并状态', async () => {
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  const r = await w.svc.run(null, w.session.id, { action: 'pr', message: 'feat: x', title: 'X', body: 'b' });
  assert.ok(r.ok);
  assert.equal(r.value.pushed, true);
  assert.equal(r.value.pullRequest?.via, 'token');
  assert.equal(r.value.pullRequest?.number, 7);
  assert.deepEqual(w.hostCalls, ['create:o/r:feat/x->main:1234']);
  assert.ok(!w.git.calls.some((c) => c.includes(':gh:')));
  assert.ok(w.audits.some((a) => a.action === 'git.pr' && !a.detail.includes('ghp_')));
  const log = await w.deps.workLog.list(w.task.id, { limit: 50 });
  assert.ok(log.some((e) => e.body.includes('o/r#7')));
  w.tick(11 * 60_000);
  assert.equal(await w.svc.syncDue(), 1);
  assert.equal(w.prs.rows[0]?.state, 'merged');
  assert.equal(await w.svc.syncDue(), 0);
});

test('刚开完的 PR：默认同步进 1 分钟节流；?refresh 立刻拉到已合并并收起', async () => {
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  const opened = await w.svc.run(null, w.session.id, { action: 'pr', message: 'feat: x', title: 'X' });
  assert.ok(opened.ok);
  assert.equal(opened.value.pullRequest?.state, 'open');
  const live = await w.deps.sessions.byId(w.session.id);
  assert.ok(live);
  await w.deps.sessions.save({ ...live, status: 'stopped' });
  const throttled = await w.svc.syncTask(null, w.task.id);
  assert.ok(throttled.ok);
  assert.equal(throttled.value[0]?.state, 'open');
  assert.ok(!w.hostCalls.includes('get:7'));
  const refreshed = await w.svc.syncTask(null, w.task.id, { refresh: true });
  assert.ok(refreshed.ok);
  assert.equal(refreshed.value[0]?.state, 'merged');
  assert.ok(w.hostCalls.includes('get:7'));
  assert.ok((await w.deps.sessions.byId(w.session.id))?.settledAt != null);
});

test('开 PR：token 失败 → gh；gh 也没有 → 只推送 + 链接', async () => {
  const w = await world({ token: true, host: { createPullRequest: async () => ({ ok: false, reason: '401' }) } });
  w.git.gh = { next: 3, state: 'open' };
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  const r = await w.svc.run(null, w.session.id, { action: 'pr', message: 'feat: x', title: 'X' });
  assert.ok(r.ok);
  assert.equal(r.value.pullRequest?.via, 'gh');
  assert.equal(r.value.pullRequest?.number, 3);
  assert.ok(r.value.notes.some((n) => n.includes('401')));

  const v = await world();
  v.git.previews.set(v.root, dirty('feat/y', 'git@github.com:o/r.git'));
  const out = await v.svc.run(null, v.session.id, { action: 'pr', message: 'feat: y', title: 'Y' });
  assert.ok(out.ok);
  assert.equal(out.value.pushed, true);
  assert.equal(out.value.pullRequest, null);
  assert.equal(out.value.compareUrl, 'https://github.com/o/r/compare/main...feat%2Fy?expand=1');
});

test('按分支认领：只在 GitHub 上、head 是会话分支的 PR，打开任务后进列表（token 路径，#262）', async () => {
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  w.listedPrs.push({ repo: 'o/r', head: 'feat/x', pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', headSha: 'h0', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' } });
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.equal(r.value.length, 1);
  const link = r.value[0]!;
  assert.equal(link.number, 42);
  assert.equal(link.via, 'token');
  assert.equal(link.branch, 'feat/x');
  assert.equal(link.base, 'main');
  assert.equal(link.sessionId, w.session.id);
  // 只查了分支；刚认领的不再同步一遍本体（lastSyncedAt 刚打上新）
  assert.deepEqual(w.hostCalls, ['list:o/r:feat/x:1234']);
  const log = await w.deps.workLog.list(w.task.id, { limit: 50 });
  assert.ok(log.some((e) => e.body.includes('o/r#42')));

  // 再开一次：1 分钟节流，不重复查；repo#number 也不重复认
  const again = await w.svc.syncTask(null, w.task.id);
  assert.ok(again.ok);
  assert.deepEqual(w.hostCalls, ['list:o/r:feat/x:1234']);
  assert.equal((await w.prs.byTask(w.task.id)).length, 1);

  // refresh：认领不重复（分支已落库），本体刷新拿到合并态并收起会话
  w.tick(1000);
  const live = await w.deps.sessions.byId(w.session.id);
  assert.ok(live);
  await w.deps.sessions.save({ ...live, status: 'stopped' });
  const refreshed = await w.svc.syncTask(null, w.task.id, { refresh: true });
  assert.ok(refreshed.ok);
  assert.equal(refreshed.value[0]?.state, 'merged');
  assert.equal((await w.prs.byTask(w.task.id)).length, 1);
  assert.ok(w.hostCalls.includes('get:42'));
});

test('按分支认领：没 token 用 gh；查不到不把列表打挂，原因进工作日志', async () => {
  // gh 可用：认领 gh 查到的 PR（列表没带 base，回落 main）
  const w = await world();
  w.git.gh = { next: 3, state: 'open', listed: [{ number: 5, url: 'https://github.com/o/r/pull/5', state: 'open', headSha: 'h0', mergedAt: null, repo: 'o/r', headRef: 'feat/y' }] };
  w.git.previews.set(w.root, dirty('feat/y', 'https://github.com/o/r.git'));
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0]?.number, 5);
  assert.equal(r.value[0]?.via, 'gh');
  assert.equal(r.value[0]?.base, 'main');

  // token 和 gh 都没有：已有链接保留，失败原因写进工作日志
  const v = await world();
  v.git.previews.set(v.root, dirty('feat/x', 'https://github.com/o/r.git'));
  await v.prs.save({ id: 'p0', taskId: v.task.id, workspaceId: null, sessionId: v.session.id, provider: 'github', via: 'gh', repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', branch: 'feat/old', base: 'main', state: 'open', headSha: 'abc', mergedAt: null, createdBy: 'u', createdAt: 1, lastSyncedAt: 1000 });
  const listed = await v.svc.syncTask(null, v.task.id);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  assert.equal(listed.value[0]?.number, 1);
  const log = await v.deps.workLog.list(v.task.id, { limit: 50 });
  assert.ok(log.some((e) => e.body.includes('按分支找已有 PR')));
});

test('按分支认领：同仓库同分支、HEAD 不同的两条任务不串线；仓库大小写不敏感（#269）', async () => {
  const w = await world({ token: true });
  // origin 的大小写就是权威值；PR 里的 owner/name 大小写不同也算同一个仓库
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/O/R.git', 'h1'));
  w.listedPrs.push({ repo: 'O/R', head: 'feat/x', pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', headSha: 'h1', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' } });
  const one = await w.svc.syncTask(null, w.task.id);
  assert.ok(one.ok);
  assert.deepEqual(one.value.map((link) => link.number), [42]);
  assert.equal(one.value[0]?.repo, 'O/R');

  // 另一个任务：同一 owner/repo、同一分支名，checkout 的 HEAD 是 h2 → 不能认领 head 为 h1 的 PR
  const task2 = await createTaskUseCase(w.deps, { projectId: w.task.projectId, title: '另一个任务' });
  assert.ok(task2.ok);
  const ws2 = newWorkspace({ projectId: w.task.projectId, workerId: null, path: '/tmp/demo-2', kind: 'temporary', ownerTaskId: task2.value.id, source: 'worktree', branch: 'feat/x', repoUrl: 'https://github.com/o/r.git', now: 1 });
  assert.ok(ws2.ok);
  await w.deps.workspaces.save(ws2.value);
  const session2 = await deriveSessionUseCase(w.deps, { taskId: task2.value.id, agentId: 'fake', model: 'm1', workspaceId: ws2.value.id });
  assert.ok(session2.ok);
  w.git.previews.set('/tmp/demo-2', dirty('feat/x', 'https://github.com/o/r.git', 'h2'));

  const other = await w.svc.syncTask(null, task2.value.id);
  assert.ok(other.ok);
  assert.equal(other.value.length, 0);
  assert.equal((await w.prs.byTask(task2.value.id)).length, 0);
  assert.equal((await w.prs.byTask(w.task.id)).length, 1);
});

test('按分支认领：同一任务的两个 checkout 同仓库同分支、HEAD 不同，后一个仍能认领（#269）', async () => {
  const w = await world({ token: true });
  // 会话工作的 checkout 是 h1；另一个同任务工作空间是同一分支的 h2
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git', 'h1'));
  const ws2 = newWorkspace({ projectId: w.task.projectId, workerId: null, path: '/tmp/demo-2', kind: 'temporary', ownerTaskId: w.task.id, source: 'worktree', branch: 'feat/x', repoUrl: 'https://github.com/o/r.git', now: 1 });
  assert.ok(ws2.ok);
  await w.deps.workspaces.save(ws2.value);
  w.git.previews.set('/tmp/demo-2', dirty('feat/x', 'https://github.com/o/r.git', 'h2'));
  // 非匹配的 h2 候选先被扫到，不能把后面 h1 的匹配候选去重掉
  w.listedPrs.push({ repo: 'o/r', head: 'feat/x', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', headSha: 'h1', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' } });
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((link) => [link.number, link.headSha]), [[7, 'h1']]);
});

test('按分支认领：别的仓库同号 PR 不会挡住本仓库的 PR（#269）', async () => {
  const w = await world({ token: true });
  // 已有一条别的仓库的 #42：编号只在仓库内唯一，不能据此跳过本仓库的 #42
  await w.prs.save({ id: 'p0', taskId: w.task.id, workspaceId: null, sessionId: w.session.id, provider: 'github', via: 'gh', repo: 'other/r', number: 42, url: 'https://github.com/other/r/pull/42', branch: 'feat/other', base: 'main', state: 'open', headSha: 'zzz', mergedAt: null, createdBy: 'u', createdAt: 1, lastSyncedAt: 1000 });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  w.listedPrs.push({ repo: 'o/r', head: 'feat/x', pr: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', headSha: 'h0', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' } });
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((link) => [link.repo, link.number]).sort(), [['o/r', 42], ['other/r', 42]]);
  assert.equal((await w.prs.byTask(w.task.id)).length, 2);
});

test('按分支认领：fork / 分支名不精确 / 老响应缺 repo·headRef 都不认（#269）', async () => {
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  w.listedPrs.push(
    // fork 的 PR：head 仓库不是本任务的 origin
    { repo: 'o/r', head: 'feat/x', pr: { number: 1, url: url(1), state: 'open', headSha: 'h0', mergedAt: null, base: 'main', repo: 'someone/r', headRef: 'feat/x' } },
    // 同名近似分支，不是当前检出的那一条
    { repo: 'o/r', head: 'feat/x', pr: { number: 2, url: url(2), state: 'open', headSha: 'h0', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x-copy' } },
    // 老 Worker 的响应：没有 repo / headRef，无法证明 head 就是这次 checkout
    { repo: 'o/r', head: 'feat/x', pr: { number: 3, url: url(3), state: 'open', headSha: 'h0', mergedAt: null, base: 'main' } }
  );
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.equal(r.value.length, 0);
  assert.equal((await w.prs.byTask(w.task.id)).length, 0);
});

test('按分支认领：已关闭 / 已合并的 PR 永不自动认领（#269）', async () => {
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  w.listedPrs.push(
    { repo: 'o/r', head: 'feat/x', pr: { number: 8, url: 'https://github.com/o/r/pull/8', state: 'merged', headSha: 'h0', mergedAt: 5, base: 'main', repo: 'o/r', headRef: 'feat/x' } },
    { repo: 'o/r', head: 'feat/x', pr: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'closed', headSha: 'h0', mergedAt: null, base: 'main', repo: 'o/r', headRef: 'feat/x' } }
  );
  const r = await w.svc.syncTask(null, w.task.id);
  assert.ok(r.ok);
  assert.equal(r.value.length, 0);
  assert.equal((await w.prs.byTask(w.task.id)).length, 0);
});

test('按分支认领：默认分支上的 checkout 不认领；base 只用 PR 报的或 preview 的 defaultBranch（#269）', async () => {
  // 默认分支是 trunk：即使 GitHub 上有同名 PR 也不认
  const w = await world({ token: true });
  w.git.previews.set(w.root, dirty('trunk', 'https://github.com/o/r.git', 'h0', 'trunk'));
  w.listedPrs.push({ repo: 'o/r', head: 'trunk', pr: { number: 6, url: 'https://github.com/o/r/pull/6', state: 'open', headSha: 'h0', mergedAt: null, base: 'trunk', repo: 'o/r', headRef: 'trunk' } });
  const onDefault = await w.svc.syncTask(null, w.task.id);
  assert.ok(onDefault.ok);
  assert.equal(onDefault.value.length, 0);
  assert.ok(!w.hostCalls.some((call) => call.startsWith('list:')));

  // PR 没报 base、preview 也不知道默认分支 → 跳过，不回落写死 main
  const v = await world({ token: true });
  v.git.previews.set(v.root, dirty('feat/x', 'https://github.com/o/r.git', 'h0', null));
  v.listedPrs.push({ repo: 'o/r', head: 'feat/x', pr: { number: 4, url: 'https://github.com/o/r/pull/4', state: 'open', headSha: 'h0', mergedAt: null, repo: 'o/r', headRef: 'feat/x' } });
  const unknownBase = await v.svc.syncTask(null, v.task.id);
  assert.ok(unknownBase.ok);
  assert.equal(unknownBase.value.length, 0);

  // PR 没报 base、preview 报 develop → 用 develop，不写死 main
  const u = await world({ token: true });
  u.git.previews.set(u.root, dirty('feat/x', 'https://github.com/o/r.git', 'h0', 'develop'));
  u.listedPrs.push({ repo: 'o/r', head: 'feat/x', pr: { number: 5, url: 'https://github.com/o/r/pull/5', state: 'open', headSha: 'h0', mergedAt: null, repo: 'o/r', headRef: 'feat/x' } });
  const fromPreview = await u.svc.syncTask(null, u.task.id);
  assert.ok(fromPreview.ok);
  assert.equal(fromPreview.value[0]?.base, 'develop');
});

test('推送：默认分支直接拒绝（#217 / #221 步骤 0）', async () => {
  const w = await world();
  w.git.previews.set(w.root, dirty('main', 'https://github.com/o/r.git'));
  const blocked = await w.svc.run(null, w.session.id, { action: 'push', message: 'x' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? '' : blocked.error.message, /默认分支/);

  // 功能分支照常推送；PR 仍然走原来的路径。
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  const pushed = await w.svc.run(null, w.session.id, { action: 'push', message: 'x' });
  assert.ok(pushed.ok);
  assert.equal(pushed.value.pushed, true);
});

test('开 PR：默认分支上拒绝；要标题', async () => {
  const w = await world();
  w.git.previews.set(w.root, dirty('main', 'https://github.com/o/r.git'));
  assert.ok(!(await w.svc.run(null, w.session.id, { action: 'pr', message: 'x', title: 'X' })).ok);
  w.git.previews.set(w.root, dirty('feat/x', 'https://github.com/o/r.git'));
  assert.ok(!(await w.svc.run(null, w.session.id, { action: 'pr', message: 'x', title: ' ' })).ok);
});

test('团队 token：没身份 / 非管理员不能看', async () => {
  const w = await world();
  const r = await w.svc.tokenStatus(null);
  assert.ok(!r.ok);
});
