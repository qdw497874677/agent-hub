import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_PRESETS, activityLabel, presetOf, testMcpConnection } from './token-presets.ts';

test('预设：勾选正好等于某个预设才算它，顺序无关；多勾一项就是自定义', () => {
  assert.equal(presetOf(['assets:read', 'projects:read', 'sessions:read']), 'readonly');
  assert.equal(presetOf(['assets:write', 'assets:read']), 'assets');
  assert.equal(presetOf(['projects:read']), 'custom');
  // 只读预设里没有任何写权限
  const readonly = TOKEN_PRESETS.find((p) => p.id === 'readonly')!;
  assert.ok(readonly.scopes.every((scope) => scope.endsWith(':read')));
  // 预设里不带高风险的 assets:publish
  assert.ok(TOKEN_PRESETS.every((p) => !p.scopes.includes('assets:publish')));
  assert.ok(TOKEN_PRESETS.every((p) => !(p.scopes as readonly string[]).includes('providers:manage')));
  assert.ok(TOKEN_PRESETS.every((p) => !(p.scopes as readonly string[]).includes('tokens:manage')));
});

test('调用记录的动作名', () => {
  assert.equal(activityLabel('mcp.call'), '调用');
  assert.equal(activityLabel('token.rotate'), '轮换');
  assert.equal(activityLabel('x.y'), 'x.y');
});

test('测试连接：数工具；401 说令牌无效；不带 cookie', async () => {
  let init: RequestInit | undefined;
  const ok = (async (_url: string, i: RequestInit) => {
    init = i;
    return new Response(JSON.stringify({ result: { tools: [{}, {}, {}] } }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await testMcpConnection('http://h/openapi/v1/mcp', 'ahp_x', ok), 3);
  assert.equal(init?.credentials, 'omit');
  const denied = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(testMcpConnection('http://h/openapi/v1/mcp', 'ahp_x', denied), /令牌无效/);
});
