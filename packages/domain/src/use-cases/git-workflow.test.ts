import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { AuditEntry } from '../account.ts';
import { asAgentId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { GitHostApi, PullRequestLink, PullRequestRepository, GitHostTokenStore } from '../ports/pull-requests.ts';
import { cleanBranchName, compareUrl, githubRepoOf, parseGitText, templateGitText } from '../git-workflow.ts';
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
      ...opts.host
    },
    ...(opts.writer ? { writer: { write: async () => ({ message: 'feat: 模型写的', title: '模型标题', body: '模型描述', branch: 'feat/model' }) } } : {}),
    hubTeamId: async () => 'team-1',
    now: () => clock
  });
  const root = '/tmp/demo';
  return { ...w, svc, audits, prs, tokens, hostCalls, session: session.value, task: task.value, root, tick: (ms: number) => (clock += ms) };
}

const dirty = (branch: string, remoteUrl: string | null) => ({
  isGit: true, branch, defaultBranch: 'main', remoteUrl, upstream: null, ahead: 0, head: 'h0',
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
