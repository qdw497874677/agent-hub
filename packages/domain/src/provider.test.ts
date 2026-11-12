import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionsOf } from './api-token.ts';
import { canManageProvider, canUseProvider, effectiveRouting, parseHubModel, providerModelExtraError, validateProviderInput, type ProviderActor } from './provider.ts';
import { providerUsableIn } from './use-cases/providers.ts';

/** 测试用主体：只在第一个团队里（一个人只属于一个团队）。 */
const actor = (teams: [string, 'owner' | 'member'][] = [], clusterAdmin = false): ProviderActor =>
  ({
    user: { id: 'u1', email: 'u1@b.co', displayName: 'u1', role: teams[0]?.[1] ?? 'member', disabledAt: null, deletedAt: null, teamId: teams[0]?.[0] ?? null, clusterAdmin },
    login: {}
  }) as unknown as ProviderActor;
const base = { scope: 'team' as const, ownerId: 't1', enabled: true, hasKey: true };

test('parseHubModel', () => {
  assert.deepEqual(parseHubModel('hub-gw/m-1.5'), { slug: 'gw', modelId: 'm-1.5' });
  assert.deepEqual(parseHubModel('hub-gw/a/b'), { slug: 'gw', modelId: 'a/b' });
  for (const bad of ['cliproxy/x', 'hub-/m', 'hub-gw/', 'hub-GW/m', null, undefined]) assert.equal(parseHubModel(bad), null);
});

test('validateProviderInput：标识、地址、模型', () => {
  const input = { slug: 'gw', name: 'GW', protocol: 'openai-chat' as const, baseUrl: 'https://api.example.com/v1', models: [{ id: 'm' }], routing: 'direct' as const, enabled: true };
  const valid = validateProviderInput({ ...input, apiKey: 'sk-test-placeholder-not-real' } as typeof input & { apiKey: string });
  assert.equal(valid.ok, true);
  assert.equal(valid.ok && 'apiKey' in valid.value, false);
  assert.equal(validateProviderInput(input).ok, true);
  assert.equal(validateProviderInput({ ...input, slug: 'Bad Slug!' }).ok, false);
  assert.equal(validateProviderInput({ ...input, baseUrl: 'https://u:p@api.example.com/v1' }).ok, false);
  assert.equal(validateProviderInput({ ...input, baseUrl: 'ftp://x' }).ok, false);
});

test('谁能管 / 谁能用', () => {
  assert.equal(canManageProvider(actor([['t1', 'owner']]), base), true);
  assert.equal(canManageProvider(actor([['t1', 'member']]), base), false);
  assert.equal(canManageProvider(actor(), { scope: 'hub', ownerId: null }), false);
  assert.equal(canManageProvider(actor([], true), { scope: 'hub', ownerId: null }), true);
  assert.equal(canUseProvider(actor([['t1', 'member']]), base, 't1').ok, true);
  assert.equal(canUseProvider(actor([['t2', 'member']]), base, 't2').ok, false);
  assert.equal(canUseProvider(null, base, 't1').ok, false, '没认证不能用');
  assert.equal(canUseProvider(actor([['t1', 'member']]), { ...base, enabled: false }, 't1').ok, false);
  assert.equal(canUseProvider(actor([['t1', 'member']]), { ...base, hasKey: false }, 't1').ok, false);
  assert.equal(canUseProvider(actor([['t1', 'member']]), { scope: 'personal', ownerId: 'u1', enabled: true, hasKey: true }, 't9').ok, false);
});

const token = (role: 'owner' | 'member' | 'viewer', scopes: Parameters<typeof permissionsOf>[0], teamId = 't1', id = 'u1'): ProviderActor =>
  ({
    user: { id, email: `${id}@b.co`, displayName: id, role, disabledAt: null, deletedAt: null, teamId, clusterAdmin: role === 'owner' },
    login: {},
    via: { tokenId: 'tok', name: 'bot', kind: 'personal', permissions: permissionsOf(scopes) }
  }) as unknown as ProviderActor;

test('令牌：没选 providers:use 不能用；选了且本人有权才能用；个人和团队仍隔离', () => {
  const hub = { scope: 'hub' as const, ownerId: null, enabled: true, hasKey: true };
  assert.equal(canUseProvider(token('owner', ['sessions:write']), hub, 't1').ok, false);
  assert.equal(canUseProvider(token('owner', ['providers:use']), hub, 't1').ok, true);
  assert.equal(canUseProvider(token('viewer', ['providers:use']), hub, 't1').ok, false);
  assert.equal(canUseProvider(token('member', ['providers:use'], 't1', 'u1'), { scope: 'personal', ownerId: 'u2', enabled: true, hasKey: true }, 't1').ok, false);
  assert.equal(canUseProvider(token('member', ['providers:use'], 't1'), { scope: 'team', ownerId: 't2', enabled: true, hasKey: true }, 't1').ok, false);
  assert.equal(canUseProvider(token('member', ['providers:use'], 't1'), { scope: 'team', ownerId: 't1', enabled: true, hasKey: true }, 't1').ok, true);
});

test('providerUsableIn（下发时按项目复查）与 effectiveRouting', () => {
  const p = { ...base, id: 'p', slug: 'gw', name: 'GW', protocol: 'openai-chat', baseUrl: 'x', models: [], routing: 'direct', lastCheck: null, createdBy: 'u1', createdAt: 0, updatedAt: 0 } as never;
  assert.equal(providerUsableIn(p, 't1', null).ok, true);
  assert.equal(providerUsableIn(p, 't2', null).ok, false);
  const personal = { ...(p as object), scope: 'personal', ownerId: 'u1' } as never;
  assert.equal(providerUsableIn(personal, 't1', 't1').ok, true);
  assert.equal(providerUsableIn(personal, 't2', 't1').ok, false);
  assert.equal(effectiveRouting({ routing: 'direct' }, 'hub'), 'hub');
  assert.equal(effectiveRouting({ routing: 'hub' }, null), 'hub');
  assert.equal(effectiveRouting({ routing: 'hub' }, undefined), 'hub');
});

test('providerModelExtraError：必须是 JSON 对象、≤4096 字节、不带禁键', () => {
  assert.equal(providerModelExtraError({ temperature: 0.2 }), null);
  assert.equal(providerModelExtraError({}), null);
  assert.equal(providerModelExtraError([]), '必须是 JSON 对象');
  assert.equal(providerModelExtraError(null), '必须是 JSON 对象');
  assert.equal(providerModelExtraError('x'), '必须是 JSON 对象');
  assert.match(providerModelExtraError({ model: 'other' }) ?? '', /不能包含「model」/);
  assert.match(providerModelExtraError({ stream: true }) ?? '', /不能包含「stream」/);
  assert.match(providerModelExtraError({ tools: [] }) ?? '', /不能包含「tools」/);
  assert.match(providerModelExtraError({ reasoning: 'x'.repeat(4096) }) ?? '', /4096 字节/);
  // 4096 字节整好压线：前缀 + 引号也算
  assert.equal(providerModelExtraError({ a: 'x'.repeat(4000) }), null);
});

test('validateProviderInput：extra 透传、非法值拒绝', () => {
  const input = { slug: 'gw', name: 'GW', protocol: 'openai-chat' as const, baseUrl: 'https://api.example.com/v1', models: [{ id: 'm', extra: { temperature: 0.2, reasoning_effort: 'low' } }], routing: 'direct' as const, enabled: true };
  const valid = validateProviderInput(input);
  assert.ok(valid.ok);
  assert.deepEqual(valid.ok && valid.value.models[0]?.extra, { temperature: 0.2, reasoning_effort: 'low' });

  const bad = validateProviderInput({ ...input, models: [{ id: 'm', extra: { messages: [] } }] });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error.message, /模型 id「m」的额外参数不能包含「messages」/);
  assert.equal(validateProviderInput({ ...input, models: [{ id: 'm', extra: 'nope' as never }] }).ok, false);
});
