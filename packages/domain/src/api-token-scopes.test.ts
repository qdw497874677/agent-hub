import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiTokenScopes } from './api-token.ts';

test('parseApiTokenScopes：JSON 数组、空格分隔旧格式、非法值', () => {
  assert.deepEqual(parseApiTokenScopes('["projects:read","sessions:write"]'), {
    ok: true,
    scopes: ['projects:read', 'sessions:write']
  });
  assert.deepEqual(parseApiTokenScopes(['tokens:manage', 'providers:read']), {
    ok: true,
    scopes: ['tokens:manage', 'providers:read']
  });
  const legacy = parseApiTokenScopes('tokens:manage providers:manage projects:read');
  assert.deepEqual(legacy, {
    ok: true,
    scopes: ['tokens:manage', 'providers:manage', 'projects:read'],
    legacy: true
  });
  assert.deepEqual(parseApiTokenScopes('not-a-scope'), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseApiTokenScopes('["projects:read"'), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseApiTokenScopes('{oops}'), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseApiTokenScopes(''), { ok: false, reason: 'empty' });
  assert.deepEqual(parseApiTokenScopes('[]'), { ok: false, reason: 'empty' });
  assert.deepEqual(parseApiTokenScopes(null), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseApiTokenScopes(['projects:read', 'not-a-scope']), { ok: false, reason: 'malformed' });
});
