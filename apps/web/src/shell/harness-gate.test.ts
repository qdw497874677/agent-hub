import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentNote,
  canSelectMachine,
  carriedProtocol,
  emptyModelOption,
  hubCovers,
  machineAvailability,
  machineAvailabilityHint,
  machineSelectable,
  startBlockReason,
  startHint,
  workerOffersAgent,
  type GateWorker
} from './harness-gate.ts';

const bare = (reason: string, providers?: readonly string[]): GateWorker => ({
  agentModels: [{ agentId: 'pi', readiness: { state: 'unavailable', reason }, ...(providers ? { providers } : {}) }]
});

test('没有原生模型、已有同协议 hub 模型：可以选机器，但空模型不能开始', () => {
  const worker = bare('未配置模型', ['openai-chat']);
  assert.equal(canSelectMachine(worker, 'pi', ['openai-chat']), true);
  assert.equal(canSelectMachine(worker, 'pi', []), false);
  assert.equal(canSelectMachine(worker, 'pi', ['anthropic']), false);
  assert.equal(startBlockReason(worker, 'pi', '', 'openai-chat'), '未配置模型');
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), null);
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'anthropic'), '未配置模型');
  assert.equal(startBlockReason(worker, 'pi', 'opencode-go/deepseek-v4-flash', 'openai-chat'), '未配置模型');
});

test('未安装不因 hub 模型放行', () => {
  const worker = bare('未安装', ['openai-chat']);
  assert.equal(canSelectMachine(worker, 'pi', ['openai-chat']), false);
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), '未安装');
});

test('「开始」的说明行：先说最挡路的那一个，能用时不说', () => {
  const ready = {
    agentId: 'pi',
    agentLabel: 'Pi',
    machine: 'remote-1',
    worker: bare('未登录', ['openai-chat']),
    model: 'pi-default',
    protocol: null,
    workspaceReady: true
  } as const;
  // 什么都没选：机器优先，其次 agent，再说运行时
  assert.equal(startHint({ ...ready, machine: null, workspaceReady: false }), '先选一台机器');
  assert.equal(startHint({ ...ready, agentId: '', workspaceReady: false }), '先选一个 agent');
  assert.equal(startHint({ ...ready, worker: undefined }), null);
  assert.equal(startHint(ready), '这台机器上的 Pi 用不了：未登录');
  // 没原因的不可用也不能念出半截冒号
  assert.equal(startHint({ ...ready, worker: bare('') }), '这台机器上的 Pi 用不了');
  // 机器和运行时都过了，才轮到工作目录
  const open = { ...ready, worker: undefined, workspaceReady: false };
  assert.equal(startHint(open), '先选一个工作目录');
  assert.equal(startHint({ ...open, workspaceNeedsPath: true }), '先选一个目录');
  // 都齐了：不渲染说明行
  assert.equal(startHint({ ...ready, worker: undefined }), null);
});

test('模型框的空值项：状态为空就显式画出来，看到的和状态一致', () => {
  // 只能用 hub 模型：写「选择模型…」，不替人选
  assert.equal(emptyModelOption(['hub-cn-glm-flash/glm-5.3-flash'], '', true), '选择模型…');
  // 有原生模型、agent 自己有默认：空值就是「用 agent 自己的默认」
  assert.equal(emptyModelOption(['native/a', 'native/b'], '', false), '用 agent 自己的默认');
  assert.equal(emptyModelOption([], '', false), '用 agent 自己的默认');
  // 选中了清单里的值：不需要空值项
  assert.equal(emptyModelOption(['hub-cn-glm-flash/glm-5.3-flash'], 'hub-cn-glm-flash/glm-5.3-flash', true), null);
});

test('「换个地方继续」带上会话自己的 Hub 模型：不因目标机器「未配置模型」误挡', () => {
  const hub = { protocol: 'openai-chat', models: [{ id: 'hub-cn-glm-flash/glm-5.3-flash' }] };
  // 会话用的就是这个 Hub 模型：协议能对上，目标机器只是没配原生模型，照样能接着跑
  assert.equal(carriedProtocol('hub-cn-glm-flash/glm-5.3-flash', [hub]), 'openai-chat');
  const worker = bare('未配置模型', ['openai-chat']);
  assert.equal(startBlockReason(worker, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), null);
  // 不是清单里的模型 / 空模型：没有协议可用，照旧挡住
  assert.equal(carriedProtocol('native/own-model', [hub]), null);
  assert.equal(carriedProtocol('', [hub]), null);
  assert.equal(startBlockReason(worker, 'pi', 'native/own-model', null), '未配置模型');
  // 机器不报这个协议：带上模型也不能放行
  const strict = bare('未配置模型', ['anthropic']);
  assert.equal(startBlockReason(strict, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), '未配置模型');
  // 真的离线仍然先挡住，和模型无关
  assert.equal(startBlockReason({ ...worker, state: 'offline' }, 'pi', 'hub-cn-glm-flash/glm-5.3-flash', 'openai-chat'), '机器不在线');
});

test('hub 模型能顶上「未配置模型」时，agent 括注和说明行都不再说「用不了」', () => {
  const worker = bare('未配置模型', ['openai-chat']);
  assert.equal(hubCovers(worker, 'pi', ['openai-chat']), true);
  assert.equal(hubCovers(worker, 'pi', []), false);
  assert.equal(hubCovers(bare('未安装', ['openai-chat']), 'pi', ['openai-chat']), false);
  assert.equal(agentNote('未配置模型', true), '选 Hub 模型');
  assert.equal(agentNote('未配置模型', false), '未配置模型');
  assert.equal(agentNote('未安装', false), '未安装');
  assert.equal(agentNote(null, false), null);
  assert.equal(agentNote('', false), null);
  const base = {
    agentId: 'pi',
    agentLabel: 'Pi',
    machine: 'local',
    worker,
    model: '',
    protocol: null,
    workspaceReady: true
  };
  assert.equal(startHint({ ...base, hubAvailable: true }), '先在「模型」里选一个 Hub 模型');
  assert.equal(startHint({ ...base, hubAvailable: false }), '这台机器上的 Pi 用不了：未配置模型');
  assert.equal(startHint({ ...base, hubAvailable: true, model: 'hub-cn-glm-flash/glm-5.3-flash', protocol: 'openai-chat' }), null);
});

const onlinePi = (patch: Partial<GateWorker> = {}): GateWorker => ({
  state: 'online',
  agentIds: ['pi'],
  agentModels: [{ agentId: 'pi', readiness: { state: 'ready' } }],
  ...patch
});

test('机器可选规则：在线、装着当前 agent、harness 可用（或 hub 模型能顶上）', () => {
  assert.equal(workerOffersAgent(onlinePi(), 'pi'), true);
  assert.equal(workerOffersAgent(onlinePi({ agentIds: ['opencode'] }), 'pi'), false);
  // 老 Worker 不报 agentIds：沿用「不拦」的旧行为
  assert.equal(workerOffersAgent({ state: 'online' }, 'pi'), true);
  assert.equal(workerOffersAgent({ state: 'online' }, ''), false);
  assert.equal(workerOffersAgent(undefined, 'pi'), false);

  assert.equal(machineSelectable(onlinePi(), 'pi', []), true);
  assert.equal(machineSelectable(onlinePi({ state: 'offline' }), 'pi', []), false);
  assert.equal(machineSelectable(onlinePi({ agentIds: ['opencode'] }), 'pi', []), false);
  const down = onlinePi({
    agentModels: [{ agentId: 'pi', readiness: { state: 'unavailable', reason: '未安装' } }]
  });
  assert.equal(machineSelectable(down, 'pi', []), false);
  const hubOnly = onlinePi({
    agentModels: [{ agentId: 'pi', providers: ['openai-chat'], readiness: { state: 'unavailable', reason: '未配置模型' } }]
  });
  assert.equal(machineSelectable(hubOnly, 'pi', []), false);
  assert.equal(machineSelectable(hubOnly, 'pi', ['openai-chat']), true);
});

test('机器空态分类：加载/失败、没接入、全离线、当前 agent 不可用分开说', () => {
  assert.deepEqual(machineAvailability([], 'pi', [], { loading: true }), { kind: 'unknown', loading: true, failed: false });
  assert.deepEqual(machineAvailability([], 'pi', [], { failed: true }), { kind: 'unknown', loading: false, failed: true });
  assert.deepEqual(machineAvailability([], 'pi', []), { kind: 'no-machines' });
  assert.deepEqual(machineAvailability([onlinePi()], '', []), { kind: 'no-agent' });
  assert.deepEqual(machineAvailability([onlinePi({ state: 'offline' })], 'pi', []), { kind: 'all-offline', total: 1 });

  const other = onlinePi({ agentIds: ['opencode'], agentModels: [{ agentId: 'opencode' }] });
  assert.deepEqual(machineAvailability([other], 'pi', []), { kind: 'agent-unavailable', online: 1, blocked: 0, missing: 1 });
  const down = onlinePi({
    agentModels: [{ agentId: 'pi', readiness: { state: 'unavailable', reason: '未安装' } }]
  });
  assert.deepEqual(machineAvailability([down], 'pi', []), { kind: 'agent-unavailable', online: 1, blocked: 1, missing: 0 });
  assert.deepEqual(machineAvailability([other, down], 'pi', []), { kind: 'agent-unavailable', online: 2, blocked: 1, missing: 1 });
  assert.deepEqual(machineAvailability([onlinePi()], 'pi', []), { kind: 'available', usable: 1, blocked: 0 });

  // 有同协议 hub 模型时，「未配置模型」的机器仍然能选
  const hubOnly = onlinePi({
    agentModels: [{ agentId: 'pi', providers: ['openai-chat'], readiness: { state: 'unavailable', reason: '未配置模型' } }]
  });
  assert.deepEqual(machineAvailability([hubOnly], 'pi', ['openai-chat']), { kind: 'available', usable: 1, blocked: 0 });
  assert.deepEqual(machineAvailability([hubOnly], 'pi', []), { kind: 'agent-unavailable', online: 1, blocked: 1, missing: 0 });
});

test('没得选时底部说明不再一律说「先选一台机器」', () => {
  const base = {
    agentId: 'pi',
    agentLabel: 'Pi',
    machine: null,
    worker: undefined,
    model: '',
    protocol: null,
    workspaceReady: false
  } as const;
  assert.equal(startHint({ ...base, machines: { kind: 'unknown', loading: true, failed: false } }), '正在读取机器状态…');
  assert.equal(startHint({ ...base, machines: { kind: 'unknown', loading: false, failed: true } }), '机器状态没读到，重新检查后再试');
  assert.equal(startHint({ ...base, machines: { kind: 'no-agent' } }), '还没有可用的 agent');
  assert.equal(startHint({ ...base, machines: { kind: 'no-machines' } }), '先在「机器」里接入一台机器');
  assert.equal(startHint({ ...base, machines: { kind: 'all-offline', total: 2 } }), '先让一台机器上线');
  assert.equal(
    startHint({ ...base, machines: { kind: 'agent-unavailable', online: 1, blocked: 0, missing: 1 } }),
    '在线的机器都没有 Pi，换一个 agent'
  );
  assert.equal(
    startHint({ ...base, machines: { kind: 'agent-unavailable', online: 2, blocked: 1, missing: 1 } }),
    '在线的机器上有的没装 Pi，有的用不了，换一个 agent'
  );
  assert.equal(
    startHint({ ...base, machines: { kind: 'agent-unavailable', online: 1, blocked: 1, missing: 0 } }),
    '在线的机器上 Pi 用不了，换一个 agent 或先修好它'
  );
  // 确实还有能选的机器：仍说「先选一台机器」
  assert.equal(startHint({ ...base, machines: { kind: 'available', usable: 1, blocked: 0 } }), '先选一台机器');
  assert.equal(machineAvailabilityHint(undefined, 'Pi'), null);
});

test('已选机器：保留选择，离线 / 不可用 / 换了 agent 后说对原因', () => {
  const selected = {
    agentId: 'pi',
    agentLabel: 'Pi',
    machine: 'w1',
    worker: onlinePi(),
    model: '',
    protocol: null,
    workspaceReady: false
  } as const;
  assert.equal(startHint({ ...selected, machines: { kind: 'available', usable: 1, blocked: 0 } }), '先选一个工作目录');
  assert.equal(
    startHint({ ...selected, worker: onlinePi({ state: 'offline' }), machines: { kind: 'all-offline', total: 1 } }),
    '这台机器不在线'
  );
  const down = onlinePi({
    agentModels: [{ agentId: 'pi', readiness: { state: 'unavailable', reason: '未安装' } }]
  });
  assert.equal(
    startHint({ ...selected, worker: down, machines: { kind: 'agent-unavailable', online: 1, blocked: 1, missing: 0 } }),
    '这台机器上的 Pi 用不了：未安装'
  );
  assert.equal(
    startHint({
      ...selected,
      worker: onlinePi({ agentIds: ['opencode'], agentModels: [{ agentId: 'opencode' }] }),
      machines: { kind: 'agent-unavailable', online: 1, blocked: 0, missing: 1 }
    }),
    '这台机器没有 Pi，换一台机器或换一个 agent'
  );
  // 机器列表刷新时短暂为空：保留机器，不下「没有机器」的结论
  assert.equal(startHint({ ...selected, worker: undefined, machines: { kind: 'unknown', loading: true, failed: false } }), '正在读取机器状态…');
});
