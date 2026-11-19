import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaultAgentLayers } from './resolve-default-agent.ts';
import type { AgentRef } from '../agent-ref.ts';

const ref = (runtime: string, model: string, options: AgentRef['options'] = {}): AgentRef => ({
  runtime,
  model,
  options
});

test('完全没说时，任务默认覆盖项目默认，团队只补模型', () => {
  const resolved = applyDefaultAgentLayers({
    project: ref('opencode', 'project-model', { effort: 'low', keep: true }),
    task: ref('codex', 'task-model', { effort: 'high' }),
    teamDefaults: { opencode: 'team-opencode', codex: 'team-codex' },
    explicit: ref('', '', {})
  });
  assert.deepEqual(resolved.effective, { runtime: 'codex', model: 'task-model', options: { effort: 'high' } });
  assert.deepEqual(resolved.sources, { runtime: 'task', model: 'task' });
  assert.equal(resolved.layers.teamModel, 'team-codex');
});

test('任务只给 runtime 时，模型先看同 runtime 的项目默认，再看团队', () => {
  const fromProject = applyDefaultAgentLayers({
    project: ref('opencode', 'project-model', { effort: 'low' }),
    task: ref('opencode', '', { effort: 'high' }),
    teamDefaults: { opencode: 'team-model' },
    explicit: ref('', '', {})
  });
  assert.equal(fromProject.effective.runtime, 'opencode');
  assert.equal(fromProject.effective.model, 'project-model');
  assert.deepEqual(fromProject.effective.options, { effort: 'high' });
  assert.deepEqual(fromProject.sources, { runtime: 'task', model: 'project' });

  const fromTeam = applyDefaultAgentLayers({
    project: ref('opencode', '', { effort: 'low' }),
    task: ref('opencode', '', {}),
    teamDefaults: { opencode: 'team-model' },
    explicit: ref('', '', { temp: true })
  });
  assert.equal(fromTeam.effective.model, 'team-model');
  assert.deepEqual(fromTeam.effective.options, { effort: 'low', temp: true });
  assert.deepEqual(fromTeam.sources, { runtime: 'task', model: 'team' });
});

test('显式 runtime / 模型永远优先；显式空模型仍可被下层同 runtime 补上', () => {
  const explicitAll = applyDefaultAgentLayers({
    project: ref('opencode', 'project-model', {}),
    task: ref('opencode', 'task-model', {}),
    teamDefaults: { opencode: 'team-model' },
    explicit: ref('opencode', 'pick', { x: true })
  });
  assert.deepEqual(explicitAll.effective, { runtime: 'opencode', model: 'pick', options: { x: true } });
  assert.deepEqual(explicitAll.sources, { runtime: 'explicit', model: 'explicit' });

  const explicitRuntime = applyDefaultAgentLayers({
    project: ref('opencode', 'project-model', {}),
    task: null,
    teamDefaults: { pi: 'team-pi' },
    explicit: ref('pi', '', {})
  });
  assert.equal(explicitRuntime.effective.runtime, 'pi');
  assert.equal(explicitRuntime.effective.model, 'team-pi');
  assert.deepEqual(explicitRuntime.sources, { runtime: 'explicit', model: 'team' });
});

test('什么都没配时 effective 为空，sources 为 unset', () => {
  const resolved = applyDefaultAgentLayers({
    project: null,
    task: null,
    teamDefaults: {},
    explicit: ref('', '', {})
  });
  assert.deepEqual(resolved.effective, { runtime: '', model: '', options: {} });
  assert.equal(resolved.layers.teamModel, null);
  assert.deepEqual(resolved.sources, { runtime: 'unset', model: 'unset' });
});
