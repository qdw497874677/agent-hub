import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PLACEHOLDER, mcpGuide } from './mcp-guide.ts';

test('接入说明：端点拼在 origin 后面，末尾斜杠不影响', () => {
  const guide = mcpGuide({ origin: 'https://hub.example.com/' });
  assert.equal(guide.url, 'https://hub.example.com/openapi/v1/mcp');
  assert.equal(guide.header, `Authorization: Bearer ${MCP_PLACEHOLDER}`);
});

test('接入说明：没有令牌时用占位符，有令牌时每份片段都带同一份', () => {
  const guide = mcpGuide({ origin: 'http://127.0.0.1:7878', token: ' ahp_test ' });
  assert.equal(guide.token, 'ahp_test');
  for (const key of ['claude', 'cursor', 'codex', 'json'] as const) {
    assert.match(guide.snippets[key], /Bearer ahp_test/);
  }
  assert.match(guide.snippets.claude, /claude mcp add --transport http agent-hub/);
  const parsed = JSON.parse(guide.snippets.cursor) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  assert.equal(parsed.mcpServers['agent-hub']?.url, 'http://127.0.0.1:7878/openapi/v1/mcp');
  assert.equal(parsed.mcpServers['agent-hub']?.headers['Authorization'], 'Bearer ahp_test');
  assert.match(guide.snippets.codex, /^\[mcp_servers\.agent-hub\]/);
  assert.match(guide.snippets.codex, /http_headers/);
});

test('给 agent 的提示词：说明轮询、幂等与不允许编 id', () => {
  const guide = mcpGuide({ origin: 'https://hub.example.com' });
  assert.match(guide.snippets.prompt, /sinceTurn=turn/);
  assert.match(guide.snippets.prompt, /clientRequestId/);
  assert.match(guide.snippets.prompt, /不要凭空编 id/);
  assert.match(guide.snippets.prompt, /task_create → session_start/);
});
