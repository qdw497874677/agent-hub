import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNote, canSelectMachine, carriedProtocol, emptyModelOption, hubCovers, startBlockReason, startHint, type GateWorker } from './harness-gate.ts';

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
