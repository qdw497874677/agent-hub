import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PLACEHOLDER, MCP_TOKEN_ENV, maskToken, mcpGuide } from './mcp-guide.ts';

test('接入说明：端点拼在 origin 后面，末尾斜杠不影响', () => {
  const guide = mcpGuide({ origin: 'https://hub.example.com/' });
  assert.equal(guide.url, 'https://hub.example.com/openapi/v1/mcp');
  assert.equal(guide.header, `Authorization: Bearer $${MCP_TOKEN_ENV}`);
  assert.equal(guide.exportLine, `export ${MCP_TOKEN_ENV}=${MCP_PLACEHOLDER}`);
});

test('接入说明：各家片段都只引用环境变量，不放明文令牌', () => {
  const guide = mcpGuide({ origin: 'http://127.0.0.1:7878' });
  for (const key of ['claude', 'cursor', 'codex'] as const) {
    assert.ok(guide.snippets[key].includes(MCP_TOKEN_ENV), key);
    assert.ok(!guide.snippets[key].includes('ahp_'), key);
  }
  const claude = JSON.parse(guide.snippets.claude) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
  assert.equal(claude.mcpServers['agent-hub']?.type, 'http');
  assert.equal(claude.mcpServers['agent-hub']?.headers['Authorization'], 'Bearer ${AGENT_HUB_TOKEN}');
  const cursor = JSON.parse(guide.snippets.cursor) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  assert.equal(cursor.mcpServers['agent-hub']?.url, 'http://127.0.0.1:7878/openapi/v1/mcp');
  assert.equal(cursor.mcpServers['agent-hub']?.headers['Authorization'], 'Bearer ${env:AGENT_HUB_TOKEN}');
  assert.match(guide.snippets.codex, /^\[mcp_servers\.agent-hub\]/);
  assert.match(guide.snippets.codex, /bearer_token_env_var = "AGENT_HUB_TOKEN"/);
  // 不再有和 Cursor 一模一样的「通用 JSON」
  assert.deepEqual(guide.tabs.map((t) => t.id), ['claude', 'cursor', 'codex', 'prompt']);
});

test('令牌打码：只露前缀', () => {
  const masked = maskToken('ahp_abcdefghijklmnopqrstuvwxyz');
  assert.ok(masked.startsWith('ahp_abcd'));
  assert.ok(!masked.includes('ijkl'));
  assert.equal(maskToken('abc'), '•'.repeat(12));
});

test('给 agent 的提示词：说明轮询、幂等与不允许编 id', () => {
  const guide = mcpGuide({ origin: 'https://hub.example.com' });
  assert.match(guide.snippets.prompt, /sinceTurn=turn/);
  assert.match(guide.snippets.prompt, /clientRequestId/);
  assert.match(guide.snippets.prompt, /不要凭空编 id/);
  assert.match(guide.snippets.prompt, /task_create → session_start/);
});
