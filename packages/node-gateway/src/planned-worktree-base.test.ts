import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlannedBases } from './planned-worktree-base.ts';
import { createGitWorkspace } from './git-workspace.ts';

test('planned bases resolve and publish exact remote commit, preserve collisions and reconcile', async () => {
  const temp = await mkdtemp('/tmp/opencode/planned-base-');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const source = join(temp, 'source'); const groups = join(temp, 'groups'); const proof = join(temp, 'proof');
    await mkdir(source); await mkdir(groups); await mkdir(join(groups, 'planned-worktrees')); await mkdir(proof, { mode: 0o700 });
    git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Test'); git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(source, 'data'), 'one'); git(source, 'add', 'data'); git(source, 'commit', '-m', 'one');
    const remote = join(temp, 'remote.git'); git(temp, 'clone', '--bare', source, remote);
    const repoUrl = 'https://example.invalid/team/repo.git';
    let calls = 0;
    const options = { groupsDir: groups, plannedProofDir: proof,
      testOnlyGit: async (args, env, cwd) => {
        calls++;
        const mapped = args.map((arg) => arg === repoUrl ? remote : arg);
        const out = execFileSync('git', mapped, { cwd, env: { ...env, GIT_ALLOW_PROTOCOL: 'file' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (args[0] === 'clone') git(args.at(-1)!, 'remote', 'set-url', 'origin', repoUrl);
        return out;
      },
    } satisfies Parameters<typeof createPlannedBases>[1];
    const denied = createPlannedBases(async () => null, options);
    assert.equal((await denied.resolvePlannedBase({ repoUrl, startRef: null })).ok, false);
    assert.equal(calls, 0);
    const adapter = createPlannedBases(async () => null, { ...options, plannedBaseAllowedOrigins: ['https://example.invalid'] });
    const preview = await adapter.resolvePlannedBase({ repoUrl, startRef: null }); assert.equal(preview.ok, true); if (!preview.ok) return;
    assert.equal(preview.value.startRef, 'refs/heads/main'); assert.equal(preview.value.oid, git(source, 'rev-parse', 'HEAD'));
    const input = { repoUrl, startRef: preview.value.startRef, expectedOid: preview.value.oid, operationId: 'operation1', targetPath: join(preview.value.managedRoot, 'bases', 'operation1') };
    const prepared = await adapter.preparePlannedBase(input); assert.equal(prepared.ok, true); if (!prepared.ok) return;
    assert.equal(await readFile(join(input.targetPath, 'data'), 'utf8'), 'one');
    assert.equal(prepared.value.oid, git(input.targetPath, 'rev-parse', 'HEAD'));
    assert.match(prepared.value.identity, /^[0-9a-f]{64}$/);
    const workspace = createGitWorkspace(async () => null, { groupsDir: groups, plannedProofDir: proof });
    const inspected = await workspace.inspectPlannedWorktree!({ sourcePath: input.targetPath, startRef: null });
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.value.identity, prepared.value.identity);
    assert.deepEqual(await adapter.preparePlannedBase({ ...input, reconcileOnly: true }), prepared);
    assert.deepEqual(await denied.preparePlannedBase({ ...input, reconcileOnly: true }), prepared);
    assert.deepEqual(await denied.preparePlannedBase(input), prepared);
    git(input.targetPath, 'config', 'user.name', 'Test'); git(input.targetPath, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(input.targetPath, 'data'), 'moved'); git(input.targetPath, 'commit', '-am', 'moved');
    assert.deepEqual(await adapter.preparePlannedBase({ ...input, reconcileOnly: true }), prepared);
    git(input.targetPath, 'update-ref', 'HEAD', input.expectedOid);
    const networkCalls = calls;
    const unauthorized = await denied.preparePlannedBase({ ...input, operationId: 'denied', targetPath: join(preview.value.managedRoot, 'bases', 'denied'), auth: { url: repoUrl, header: 'Authorization: Basic dGVzdA==' } });
    assert.equal(unauthorized.ok, false); if (!unauthorized.ok) assert.equal(unauthorized.error.operationSettled, true); assert.equal(calls, networkCalls);
    const malformed = createPlannedBases(async () => null, { ...options, plannedBaseAllowedOrigins: ['https://example.invalid/'] });
    assert.equal((await malformed.resolvePlannedBase({ repoUrl, startRef: null })).ok, false); assert.equal(calls, networkCalls);
    assert.deepEqual(await adapter.preparePlannedBase(input), prepared);
    const altered = await adapter.preparePlannedBase({ ...input, expectedOid: '0'.repeat(40), reconcileOnly: true }); assert.equal(altered.ok, false);
    await writeFile(join(source, 'data'), 'two'); git(source, 'commit', '-am', 'two'); git(source, 'push', remote, 'main');
    const beforeRetry = calls;
    const changed = await adapter.preparePlannedBase(input); assert.deepEqual(changed, prepared);
    assert.equal(calls - beforeRetry, 3); // local identity probes only, never ls-remote
    const stale = await adapter.preparePlannedBase({ ...input, operationId: 'stale', targetPath: join(preview.value.managedRoot, 'bases', 'stale') });
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.operationSettled, undefined);
    const fresh = await adapter.resolvePlannedBase({ repoUrl, startRef: 'refs/heads/main' }); assert.equal(fresh.ok, true); if (!fresh.ok) return;
    const collision = join(preview.value.managedRoot, 'bases', 'collision'); await mkdir(collision); await writeFile(join(collision, 'keep'), 'safe');
    const blocked = await adapter.preparePlannedBase({ ...input, operationId: 'collision', targetPath: collision, expectedOid: fresh.value.oid }); assert.equal(blocked.ok, false);
    assert.equal(await readFile(join(collision, 'keep'), 'utf8'), 'safe');
    assert.equal((await adapter.resolvePlannedBase({ repoUrl: 'file:///tmp/no', startRef: null })).ok, false);
    assert.equal((await adapter.resolvePlannedBase({ repoUrl, startRef: 'main' })).ok, false);
    const outstandingPath = join(proof, 'base-outstanding.json');
    await writeFile(outstandingPath, JSON.stringify({ version: 2, operationId: 'outstanding', targetPath: join(preview.value.managedRoot, 'bases', 'outstanding'), urlHash: (await import('node:crypto')).createHash('sha256').update(repoUrl).digest('hex'), startRef: input.startRef, oid: input.expectedOid }));
    const beforeOutstanding = calls;
    const outstanding = await adapter.preparePlannedBase({ ...input, operationId: 'outstanding', targetPath: join(preview.value.managedRoot, 'bases', 'outstanding') });
    assert.equal(outstanding.ok, false); assert.equal(calls, beforeOutstanding);
    await rename(join(input.targetPath, '.git'), join(input.targetPath, '.git.saved'));
    await mkdir(join(input.targetPath, '.git'));
    const tampered = await denied.preparePlannedBase({ ...input, reconcileOnly: true });
    assert.equal(tampered.ok, false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
