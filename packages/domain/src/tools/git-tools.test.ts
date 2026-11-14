import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Subject } from '../access.ts';
import { conflict, forbidden } from '../errors.ts';
import type { PullRequestLink } from '../ports/pull-requests.ts';
import { err, ok } from '../result.ts';
import { DEFAULT_TOOL_SCOPES, TOOL_SCOPES, type ToolGrant } from '../tool.ts';
import type { GitRunInput, GitRunOutcome, GitState } from '../use-cases/git-workflow.ts';
import { createGitToolProvider, GIT_MESSAGE_MAX, GIT_PR_BODY_MAX, GIT_TOOLS, type GitWorkflow } from './git-tools.ts';

const subject = { user: { id: 'u1', email: 'u1@example.com' } } as unknown as Subject;

const gitState: GitState = {
  isGit: true,
  branch: 'feat/x',
  defaultBranch: 'main',
  hasOrigin: true,
  repo: 'acme/app',
  files: [],
  ahead: 0,
  upstream: 'origin/feat/x',
  canPush: true,
  prBlocked: null,
  prVia: 'gh',
  pullRequests: []
};

const outcome: GitRunOutcome = {
  sha: 'abc123',
  committed: true,
  pushed: true,
  branch: 'feat/x',
  pullRequest: null,
  compareUrl: null,
  notes: []
};

const link: PullRequestLink = {
  id: 'pr1',
  taskId: 't1',
  workspaceId: null,
  sessionId: 's1',
  provider: 'github',
  via: 'gh',
  repo: 'acme/app',
  number: 7,
  url: 'https://github.com/acme/app/pull/7',
  branch: 'feat/x',
  base: 'main',
  state: 'open',
  headSha: 'abc123',
  mergedAt: null,
  createdBy: 'u1',
  createdAt: 1,
  lastSyncedAt: 1
};

interface Seen {
  readonly op: string;
  readonly subject: Subject | null;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly input?: GitRunInput;
  readonly workspace?: string;
}

function world(overrides: Partial<GitWorkflow> = {}, subjectResult: Subject | null = subject) {
  const seen: Seen[] = [];
  const subjectCalls: string[] = [];
  const workflow: GitWorkflow = {
    state: async (s, sessionId, workspace) => {
      seen.push({ op: 'state', subject: s, sessionId, ...(workspace === undefined ? {} : { workspace }) });
      return overrides.state ? overrides.state(s, sessionId, workspace) : ok(gitState);
    },
    run: async (s, sessionId, input, workspace) => {
      seen.push({ op: 'run', subject: s, sessionId, input, ...(workspace === undefined ? {} : { workspace }) });
      return overrides.run ? overrides.run(s, sessionId, input, workspace) : ok(outcome);
    },
    listForTask: async (s, taskId) => {
      seen.push({ op: 'list', subject: s, taskId });
      return overrides.listForTask ? overrides.listForTask(s, taskId) : ok([link]);
    }
  };
  const provider = createGitToolProvider({
    workflow,
    subjectOf: async (sessionId) => {
      subjectCalls.push(sessionId);
      return subjectResult;
    }
  });
  const ctx = (taskId = 't1') => ({ grant: { sessionId: 's1', taskId, scopes: ['git'] } as unknown as ToolGrant, now: 0 });
  return { provider, seen, subjectCalls, ctx };
}

test('git 工具：scope=git、perMinute=10，默认授权能看到', () => {
  assert.deepEqual(GIT_TOOLS.map((t) => t.name).sort(), ['git.commit', 'git.pr', 'git.pull_requests', 'git.push', 'git.state']);
  for (const tool of GIT_TOOLS) {
    assert.equal(tool.scope, 'git');
    assert.equal(tool.perMinute, 10);
    assert.equal(tool.inputSchema['additionalProperties'], false);
    assert.match(tool.description, /shell/);
  }
  assert.ok(TOOL_SCOPES.includes('git'));
  assert.ok(DEFAULT_TOOL_SCOPES.includes('git'));
});

test('git.state：转发 subject / sessionId / workspace，返回 GitState', async () => {
  const { provider, seen, subjectCalls, ctx } = world();
  const res = await provider.call('git.state', {}, ctx());
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(res.value, gitState);
  const forwarded: Seen[] = [{ op: 'state', subject, sessionId: 's1' }];
  assert.deepEqual(seen, forwarded);
  assert.deepEqual(subjectCalls, ['s1']);

  const withMember = await provider.call('git.state', { workspace: 'w9' }, ctx());
  assert.ok(withMember.ok);
  assert.equal(seen.at(-1)?.workspace, 'w9');
});

test('git.commit / git.push / git.pr：各自转发 action 与参数', async () => {
  const { provider, seen, ctx } = world();
  const commit = await provider.call('git.commit', { message: ' 修一下 ' }, ctx());
  assert.ok(commit.ok);
  assert.deepEqual(seen.at(-1)?.input, { action: 'commit', message: '修一下' });

  const push = await provider.call('git.push', { message: '推送', workspace: 'w9' }, ctx());
  assert.ok(push.ok);
  assert.deepEqual(seen.at(-1)?.input, { action: 'push', message: '推送' });
  assert.equal(seen.at(-1)?.workspace, 'w9');

  const pr = await provider.call('git.pr', { message: '开 PR', title: ' feat: x ', body: '正文' }, ctx());
  assert.ok(pr.ok);
  assert.deepEqual(seen.at(-1)?.input, { action: 'pr', message: '开 PR', title: 'feat: x', body: '正文' });
  assert.deepEqual(pr.value, outcome);
});

test('git.pull_requests：读当前任务的 PR 列表', async () => {
  const { provider, seen, ctx } = world();
  const res = await provider.call('git.pull_requests', {}, ctx('t9'));
  assert.ok(res.ok);
  assert.deepEqual(res.value, [link]);
  const forwarded: Seen[] = [{ op: 'list', subject, taskId: 't9' }];
  assert.deepEqual(seen, forwarded);
});

test('入参校验：空 message / 超长 message / 超长 title / 超长 body / 未知字段', async () => {
  const { provider, seen, ctx } = world();
  const cases: [string, Record<string, unknown>][] = [
    ['git.commit', { message: '   ' }],
    ['git.push', { message: 'x'.repeat(GIT_MESSAGE_MAX + 1) }],
    ['git.pr', { message: 'm', title: 'x'.repeat(201) }],
    ['git.pr', { message: 'm', body: 'x'.repeat(GIT_PR_BODY_MAX + 1) }],
    ['git.commit', { message: 'm', extra: 1 }],
    ['git.state', { message: 'm' }],
    ['git.pull_requests', { workspace: 'w9' }],
    ['git.state', { workspace: '' }]
  ];
  for (const [name, input] of cases) {
    const res = await provider.call(name, input, ctx());
    assert.equal(!res.ok && res.error.code, 'invalid', `${name} ${JSON.stringify(input)}`);
  }
  assert.equal(seen.length, 0);
});

test('工作流失败原样透传，不包装成 invalid', async () => {
  const denied = forbidden('你没有这个项目的推送权限（git.push）');
  const { provider, ctx } = world({ run: async () => err(denied), state: async () => err(conflict('请选择要提交的仓库')) });
  const push = await provider.call('git.push', { message: 'm' }, ctx());
  assert.equal(!push.ok && push.error, denied);
  assert.equal(!push.ok && push.error.code, 'forbidden');
  const state = await provider.call('git.state', {}, ctx());
  assert.equal(!state.ok && state.error.code, 'conflict');
  assert.equal(!state.ok && state.error.message, '请选择要提交的仓库');
});

test('subjectOf 返回 null 时工具照常工作，把 null 交给工作流', async () => {
  const { provider, seen, ctx } = world({}, null);
  const res = await provider.call('git.state', {}, ctx());
  assert.ok(res.ok);
  assert.equal(seen[0]?.subject, null);
});
