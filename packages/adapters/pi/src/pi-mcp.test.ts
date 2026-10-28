import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiMcpConfig, piAgentDir, piMcpEntry, piHasBuiltinMcp, piMcpPath, piToolEnv } from './pi-mcp.ts';

test('mcp-adapter.json：保留用户已有的服务器，补上 agent-hub（只有变量引用，没有令牌）；重复调用不写', async () => {
  const shim = { command: '/usr/bin/node', args: ['/w/mcp-shim.ts'] };
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-'));
  const path = join(dir, 'agent', 'mcp-adapter.json');
  const opts = { dir: join(dir, 'agent') };
  assert.equal(await ensurePiMcpConfig(shim, opts), true);
  assert.equal(await ensurePiMcpConfig(shim, opts), false);
  await writeFile(path, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
  assert.equal(await ensurePiMcpConfig(shim, opts), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.mcpServers.mine, { command: 'x' });
  assert.deepEqual(saved.mcpServers['agent-hub'], piMcpEntry(shim));
  // url 不能是变量引用（Pi 按字面校验），所以是 stdio 条目，只有 env 里有引用
  assert.equal('url' in saved.mcpServers['agent-hub'], false);
  assert.equal(saved.mcpServers['agent-hub'].env.AGENT_HUB_TOOL_TOKEN, '${AGENT_HUB_TOOL_TOKEN}');
  assert.doesNotMatch(JSON.stringify(saved), /secret-token/);
  assert.deepEqual(piToolEnv({ url: 'http://h/mcp', token: 'secret-token' }), {
    AGENT_HUB_TOOL_URL: 'http://h/mcp',
    AGENT_HUB_TOOL_TOKEN: 'secret-token',
    AGENT_HUB_MCP: '[]'
  });
  assert.deepEqual(piToolEnv(undefined), {});
});

test('写进 mcp-adapter.json（适配器的用户全局配置，不走项目信任）；拿掉旧 mcp.json 里我们那条，用户的保留', async () => {
  const shim = { command: '/usr/bin/node', args: ['/w/mcp-shim.ts'] };
  const dir = join(await mkdtemp(join(tmpdir(), 'pi-mcp-')), 'agent');
  await mkdir(dir, { recursive: true });
  const legacy = join(dir, 'mcp.json');
  const adapter = piMcpPath({ PI_CODING_AGENT_DIR: dir });
  assert.equal(adapter, join(dir, 'mcp-adapter.json'));
  // 用户自己的适配器设置（含信任策略）原样保留
  await writeFile(adapter, JSON.stringify({ settings: { projectServers: 'ask' }, mcpServers: { mine: { command: 'y' } } }));
  // 旧版本只写了我们那条：整个文件删掉
  await writeFile(legacy, JSON.stringify({ mcpServers: { 'agent-hub': piMcpEntry(shim) } }));
  assert.equal(await ensurePiMcpConfig(shim, { dir }), true);
  await assert.rejects(stat(legacy));
  const saved = JSON.parse(await readFile(adapter, 'utf8'));
  assert.deepEqual(saved.settings, { projectServers: 'ask' });
  assert.deepEqual(saved.mcpServers.mine, { command: 'y' });
  assert.deepEqual(saved.mcpServers['agent-hub'], piMcpEntry(shim));
  assert.equal(await ensurePiMcpConfig(shim, { dir }), false);
  // 旧 mcp.json 里还有用户自己的服务器：只删我们那条
  await writeFile(legacy, JSON.stringify({ mcpServers: { 'agent-hub': piMcpEntry(shim), theirs: { command: 'z' } } }));
  assert.equal(await ensurePiMcpConfig(shim, { dir }), true);
  assert.deepEqual(JSON.parse(await readFile(legacy, 'utf8')), { mcpServers: { theirs: { command: 'z' } } });
  // 用户自己叫 agent-hub 的条目（不是我们的变量引用）不碰
  await writeFile(legacy, JSON.stringify({ mcpServers: { 'agent-hub': { command: 'user' } } }));
  assert.equal(await ensurePiMcpConfig(shim, { dir }), false);
  assert.deepEqual(JSON.parse(await readFile(legacy, 'utf8')).mcpServers['agent-hub'], { command: 'user' });
});

test('piAgentDir 认 PI_CODING_AGENT_DIR，默认 ~/.pi/agent', () => {
  assert.equal(piAgentDir({}, '/h'), '/h/.pi/agent');
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '~/x' }, '/h'), '/h/x');
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '/abs' }, '/h'), '/abs');
});

test('Pi 0.99+ 自带 MCP：写 mcp.json，拿掉 mcp-adapter.json 里我们那条', async () => {
  const shim = { command: '/usr/bin/node', args: ['/w/mcp-shim.ts'] };
  const dir = join(await mkdtemp(join(tmpdir(), 'pi-mcp-')), 'agent');
  await mkdir(dir, { recursive: true });
  const adapter = join(dir, 'mcp-adapter.json');
  await writeFile(adapter, JSON.stringify({ mcpServers: { 'agent-hub': piMcpEntry(shim) } }));
  assert.equal(await ensurePiMcpConfig(shim, { dir, builtin: true }), true);
  await assert.rejects(stat(adapter));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')).mcpServers['agent-hub'], piMcpEntry(shim));
  assert.equal(piMcpPath({ PI_CODING_AGENT_DIR: dir }, '/h', true), join(dir, 'mcp.json'));
});

test('piHasBuiltinMcp 按 pi --version 判断', () => {
  assert.equal(piHasBuiltinMcp('0.85.1'), false);
  assert.equal(piHasBuiltinMcp('0.99.0'), true);
  assert.equal(piHasBuiltinMcp('pi 1.4.0\n'), true);
  assert.equal(piHasBuiltinMcp('???'), false);
});
