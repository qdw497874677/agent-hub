import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseRoute, formatRoute } from '../../shell/route.ts';
import { eligibleWorkdir } from './workdir-model.ts';

test('workdir route round trips without changing legacy session deep links', () => {
  const route = { page: 'project', projectId: 'p/1', view: 'workdir', sessionId: 'w/1' } as const;
  assert.equal(formatRoute(route), '#/p/p%2F1/workdir/w%2F1');
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute('#/p/p/focus/s'), { page: 'project', projectId: 'p', view: 'focus', sessionId: 's' });
  assert.equal(parseRoute('#/p/p/workdir')?.page, 'project');
  assert.deepEqual(parseRoute('#/p/p/workdir'), { page: 'project', projectId: 'p', view: 'list', sessionId: null });
});

test('only ready or kept single workdirs with proven project ownership are eligible', () => {
  const workspace = { state: 'ready', groupId: null };
  assert.equal(eligibleWorkdir(workspace, 'p', 'p'), true);
  assert.equal(eligibleWorkdir({ ...workspace, state: 'kept' }, 'p', 'p'), true);
  assert.equal(eligibleWorkdir({ ...workspace, groupId: 'g' }, 'p', 'p'), false);
  assert.equal(eligibleWorkdir({ ...workspace, state: 'preparing' }, 'p', 'p'), false);
  assert.equal(eligibleWorkdir(workspace, null, 'p'), false);
  assert.equal(eligibleWorkdir(workspace, 'other', 'p'), false);
});
