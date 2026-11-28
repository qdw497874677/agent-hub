import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { runAhub } from './ahub.ts';

type Call = { method: string; path: string; body?: any };
const env = { AHUB_HUB_URL: 'https://fixture.invalid', AHUB_API_TOKEN: 'ahp_synthetic' };

async function scenario(args: string[], answers: string[], tty = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-interactive-'));
  const calls: Call[] = [];
  let stdout = '', stderr = '';
  const input = Readable.from((async function* () {
    for (const answer of answers) { await sleep(30); yield `${answer}\n`; }
  })()) as NodeJS.ReadStream;
  Object.defineProperty(input, 'isTTY', { value: tty });
  const out = { isTTY: tty, write: (s: string) => { stdout += s; return true; } };
  const err = { write: (s: string) => { stderr += s; return true; } };
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/openapi\/v1/, '') + parsed.search;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${env.AHUB_API_TOKEN}`);
    let value: unknown;
    if (method === 'GET' && path === '/me') value = { user: { id: 'user', name: 'User' }, token: { id: 'token', name: 'Token' }, capabilities: ['session_targets_v1', 'bounded_session_start_v1'] };
    else if (method === 'GET' && path === '/projects') value = [{ id: 'p1', name: 'Same project' }, { id: 'p2', name: 'Same project' }];
    else if (method === 'GET' && path === '/tasks?projectId=p2') value = [{ id: 't1', projectId: 'p2', title: 'Same task' }, { id: 't2', projectId: 'p2', title: 'Same task' }];
    else if (method === 'GET' && path === '/tasks/t2') value = { id: 't2', projectId: 'p2', title: 'Same task' };
    else if (method === 'GET' && path === '/tasks/t2/session-targets') value = { taskId: 't2', workers: [
      { workerId: 'w1', label: 'Same worker', availability: 'ready', blockers: [], workspaces: [{ workspaceId: 'd1', label: 'First', availability: 'ready', blockers: [] }] },
      { workerId: 'w2', label: 'Same worker', availability: 'ready', blockers: [], workspaces: [{ workspaceId: 'd2', label: 'Same directory', availability: 'ready', blockers: [] }, { workspaceId: 'd3', label: 'Same directory', availability: 'ready', blockers: [] }] }
    ] };
    else if (method === 'GET' && path === '/workers') value = [
      { workerId: 'hidden', label: 'UNAUTHORIZED_WORKER', state: 'online', agentModels: [{ agentId: 'secret-agent', models: ['secret-model'], readiness: { state: 'ready' } }] },
      { workerId: 'w1', label: 'Same worker', state: 'online', agentModels: [{ agentId: 'wrong-agent', models: ['wrong-model'], readiness: { state: 'ready' } }] },
      { workerId: 'w2', label: 'Same worker', state: 'online', agentModels: [
        { agentId: 'agent1', models: ['model1'], defaultModel: 'model1', readiness: { state: 'ready' } },
        { agentId: 'agent2', models: ['model2', 'model3'], defaultModel: 'model2', readiness: { state: 'ready' } }
      ] }
    ];
    else if (method === 'POST' && path === '/tasks') value = { id: 'created', projectId: body.projectId };
    else if (method === 'POST' && path === '/sessions') value = { id: 'session1', ...body };
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return new Response(JSON.stringify(value), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const code = await runAhub(args, { env, input, out, err, fetch: fetcher, profileDir: join(dir, 'profile'), stateDir: join(dir, 'state') });
    return { code, stdout, stderr, calls };
  } finally { input.destroy(); rmSync(dir, { recursive: true, force: true }); }
}

test('TTY task creation selects an unambiguous project and requires confirmation', async () => {
  const result = await scenario(['task', 'create', '--title', 'A task'], ['2', 'yes']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stderr.includes('Same project'), 'menu belongs on stderr');
  assert.ok(!result.stdout.includes('Same project'), 'menu must not contaminate stdout');
  const writes = result.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/tasks');
  assert.deepEqual(writes[0].body, { projectId: 'p2', title: 'A task' });
});

test('TTY start chooses scoped targets and inventory without substituting duplicate labels', async () => {
  const result = await scenario(['session', 'start'], ['2', '2', '2', '2', '2', '2', 'y']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stderr.includes('Same project') && result.stderr.includes('Same task'), 'chooser is on stderr');
  assert.ok(!result.stdout.includes('Same project'), 'chooser is not on stdout');
  assert.ok(!result.stderr.includes('UNAUTHORIZED_WORKER') && !result.stderr.includes('secret-agent') && !result.stderr.includes('wrong-agent'), 'only eligible selected worker inventory is exposed');
  assert.ok(result.calls.some(call => call.path === '/tasks?projectId=p2'));
  assert.ok(result.calls.some(call => call.path === '/tasks/t2/session-targets'));
  const writes = result.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/sessions');
  assert.deepEqual(writes[0].body, { taskId: 't2', workerId: 'w2', workspaceId: 'd3', agentId: 'agent2', model: 'model3', placement: 'bounded_v1' });
});

test('zero choice, blank confirmation and non-affirmative confirmation never write', async () => {
  for (const answers of [['0'], ['1', ''], ['1', 'n'], ['1', 'anything']]) {
    const result = await scenario(['task', 'create', '--title', 'A task'], answers);
    assert.notEqual(result.code, 0, `answers ${JSON.stringify(answers)}`);
    assert.ok(result.calls.every(call => call.method !== 'POST'), `answers ${JSON.stringify(answers)}`);
  }
});

test('an explicit task still requires numbered choices even for single-item menus', async () => {
  const result = await scenario(['session', 'start', '--task', 't2'], ['1', '1', '1', '1', 'yes']);
  assert.equal(result.code, 0, result.stderr);
  const writes = result.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { taskId: 't2', workerId: 'w1', workspaceId: 'd1', agentId: 'wrong-agent', model: 'wrong-model', placement: 'bounded_v1' });
  assert.ok(!result.calls.some(call => call.path.startsWith('/tasks?')));
  const withoutNumbers = await scenario(['session', 'start', '--task', 't2', '--worker', 'w1'], ['yes']);
  assert.notEqual(withoutNumbers.code, 0);
  assert.ok(withoutNumbers.calls.every(call => call.method !== 'POST'));
});

test('start cancellation and worker outside task authorization scope cannot write', async () => {
  const cancelled = await scenario(['session', 'start'], ['2', '2', '2', '2', '2', '2', '']);
  assert.notEqual(cancelled.code, 0);
  assert.ok(cancelled.calls.every(call => call.method !== 'POST'));
  const outOfScope = await scenario(['session', 'start', '--task', 't2', '--worker', 'hidden'], []);
  assert.notEqual(outOfScope.code, 0);
  assert.ok(outOfScope.calls.every(call => call.method !== 'POST'));
  assert.ok(!outOfScope.stderr.includes('UNAUTHORIZED_WORKER') && !outOfScope.stderr.includes('secret-agent'));
});

test('non-TTY or JSON missing IDs never opens a chooser or writes', async () => {
  for (const command of [['task', 'create', '--title', 'A task'], ['session', 'start']]) {
    for (const [tty, suffix] of [[false, []], [true, ['--json']]] as const) {
      const result = await scenario([...command, ...suffix], [], tty);
      assert.notEqual(result.code, 0);
      assert.ok(result.calls.every(call => call.method !== 'POST'));
      assert.ok(!result.calls.some(call => ['/projects', '/workers'].includes(call.path) || call.path.includes('/session-targets')), JSON.stringify(result.calls));
      assert.ok(!result.stderr.includes('Same project'));
    }
  }
});
