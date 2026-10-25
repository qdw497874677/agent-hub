import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiMcpConfig, piToolEnv, piMcpEntry } from './pi-mcp.ts';

test('mcp.json：保留用户已有的服务器，补上 agent-hub（只有变量引用，没有令牌）；重复调用不写', async () => {
  const shim = { command: '/usr/bin/node', args: ['/w/mcp-shim.ts'] };
  const dir = await mkdtemp(join(tmpdir(), 'pi-mcp-'));
  const path = join(dir, 'agent', 'mcp.json');
  assert.equal(await ensurePiMcpConfig(shim, path), true);
  assert.equal(await ensurePiMcpConfig(shim, path), false);
  await writeFile(path, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
  assert.equal(await ensurePiMcpConfig(shim, path), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.mcpServers.mine, { command: 'x' });
  assert.deepEqual(saved.mcpServers['agent-hub'], piMcpEntry(shim));
  // url 不能是变量引用（Pi 按字面校验），所以是 stdio 条目，只有 env 里有引用
  assert.equal('url' in saved.mcpServers['agent-hub'], false);
  assert.equal(saved.mcpServers['agent-hub'].env.AGENT_HUB_TOOL_TOKEN, '${AGENT_HUB_TOOL_TOKEN}');
  assert.doesNotMatch(JSON.stringify(saved), /secret-token/);
  assert.deepEqual(piToolEnv({ url: 'http://h/mcp', token: 'secret-token' }), { AGENT_HUB_TOOL_URL: 'http://h/mcp', AGENT_HUB_TOOL_TOKEN: 'secret-token' });
  assert.deepEqual(piToolEnv(undefined), {});
});
