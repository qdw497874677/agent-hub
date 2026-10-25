import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiMcpConfig, piToolEnv, PI_MCP_ENTRY } from './pi-mcp.ts';

test('mcp.json：保留用户已有的服务器，补上 agent-hub（只有变量引用，没有令牌）；重复调用不写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-'));
  const path = join(dir, 'agent', 'mcp.json');
  assert.equal(await ensurePiMcpConfig(path), true);
  assert.equal(await ensurePiMcpConfig(path), false);
  await writeFile(path, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
  assert.equal(await ensurePiMcpConfig(path), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.mcpServers.mine, { command: 'x' });
  assert.deepEqual(saved.mcpServers['agent-hub'], PI_MCP_ENTRY);
  assert.doesNotMatch(JSON.stringify(saved), /secret-token/);
  assert.deepEqual(piToolEnv({ url: 'http://h/mcp', token: 'secret-token' }), { AGENT_HUB_TOOL_URL: 'http://h/mcp', AGENT_HUB_TOOL_TOKEN: 'secret-token' });
  assert.deepEqual(piToolEnv(undefined), {});
});
