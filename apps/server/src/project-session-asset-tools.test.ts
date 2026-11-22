import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_ASSET_WRITE_TOOL_SCOPE,
  PROJECT_READ_TOOL_SCOPE,
  asSessionId,
  asUserId,
  err,
  ok,
  unavailable,
  type DomainError,
  type Result,
  type ToolContext,
  type ToolGrant,
  type ToolScope
} from '@agent-hub/domain';
import {
  PROJECT_ASSET_CREATE_TOOL_NAME,
  PROJECT_ASSET_LIST_TOOL_NAME,
  PROJECT_ASSET_READ_TOOL_NAME,
  PROJECT_ASSET_REVISE_TOOL_NAME,
  PROJECT_ASSET_SET_ENABLED_TOOL_NAME,
  createProjectAssetToolProvider,
  type ProjectAssetCreateCommand,
  type ProjectAssetEnableSnapshot,
  type ProjectAssetListQuery,
  type ProjectAssetReadQuery,
  type ProjectAssetReadSnapshot,
  type ProjectAssetReviseCommand,
  type ProjectAssetSetEnabledCommand,
  type ProjectAssetSummary,
  type ProjectAssetToolDeps,
  type ProjectAssetWriteSnapshot
} from './project-session-asset-tools.ts';

const SESSION_ID = asSessionId('ses-asset');
const ACTOR_ID = asUserId('u-asset');
const READ_SCOPE: ToolScope = PROJECT_READ_TOOL_SCOPE;
const WRITE_SCOPE: ToolScope = PROJECT_ASSET_WRITE_TOOL_SCOPE;
const DIGEST = 'd'.repeat(64);
const SHA = 'a'.repeat(64);

const EFFECTIVE: ProjectAssetSummary = {
  assetId: 'ast-1',
  kind: 'skill',
  name: 'my-skill',
  scope: 'project',
  sourceType: 'upload',
  enabled: true,
  overridden: true,
  shadowedBy: null,
  published: true
};

const DISABLED: ProjectAssetSummary = {
  assetId: 'ast-2',
  kind: 'instruction',
  name: 'off-instruction',
  scope: 'project',
  sourceType: 'git',
  enabled: false,
  overridden: false,
  shadowedBy: null,
  published: true
};

const SHADOWED: ProjectAssetSummary = {
  assetId: 'ast-3',
  kind: 'skill',
  name: 'shadowed-skill',
  scope: 'team',
  sourceType: 'upload',
  enabled: true,
  overridden: false,
  shadowedBy: 'ast-1',
  published: true
};

function readSnapshot(overrides: Partial<ProjectAssetReadSnapshot> = {}): ProjectAssetReadSnapshot {
  return {
    assetId: 'ast-1',
    kind: 'skill',
    name: 'my-skill',
    scope: 'project',
    digest: DIGEST,
    files: [{ path: 'SKILL.md', sha256: SHA, size: 5 }],
    file: null,
    ...overrides
  };
}

function writeSnapshot(overrides: Partial<ProjectAssetWriteSnapshot> = {}): ProjectAssetWriteSnapshot {
  return {
    assetId: 'ast-1',
    kind: 'skill',
    name: 'my-skill',
    scope: 'project',
    digest: DIGEST,
    published: false,
    submissionId: 'sub-1',
    submissionStatus: 'pending',
    ...overrides
  };
}

function enableSnapshot(overrides: Partial<ProjectAssetEnableSnapshot> = {}): ProjectAssetEnableSnapshot {
  return { assetId: 'ast-1', enabled: true, overridden: true, ...overrides };
}

function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
    id: 'grant-1',
    tokenHash: 'hash',
    taskId: null,
    sessionId: SESSION_ID,
    workerId: 'local',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    createdAt: 1,
    expiresAt: 1_000,
    revokedAt: null,
    actor: { userId: ACTOR_ID, via: 'web' },
    ...overrides
  };
}

function ctx(overrides: Partial<ToolGrant> = {}): ToolContext {
  return { grant: grant(overrides), now: 1 };
}

function world() {
  const listQueries: ProjectAssetListQuery[] = [];
  const readQueries: ProjectAssetReadQuery[] = [];
  const createCommands: ProjectAssetCreateCommand[] = [];
  const reviseCommands: ProjectAssetReviseCommand[] = [];
  const enableCommands: ProjectAssetSetEnabledCommand[] = [];
  let listResult: Result<readonly ProjectAssetSummary[], DomainError> = ok([EFFECTIVE]);
  let readResultValue: Result<ProjectAssetReadSnapshot, DomainError> = ok(readSnapshot());
  let createResult: Result<ProjectAssetWriteSnapshot, DomainError> = ok(writeSnapshot());
  let reviseResult: Result<ProjectAssetWriteSnapshot, DomainError> = ok(writeSnapshot());
  let enableResultValue: Result<ProjectAssetEnableSnapshot, DomainError> = ok(enableSnapshot());

  const deps: ProjectAssetToolDeps = {
    scopes: { read: READ_SCOPE, write: WRITE_SCOPE },
    listAssets: async (query) => {
      listQueries.push(query);
      return listResult;
    },
    readAsset: async (query) => {
      readQueries.push(query);
      return readResultValue;
    },
    createAsset: async (command) => {
      createCommands.push(command);
      return createResult;
    },
    reviseAsset: async (command) => {
      reviseCommands.push(command);
      return reviseResult;
    },
    setAssetEnabled: async (command) => {
      enableCommands.push(command);
      return enableResultValue;
    }
  };

  return {
    provider: createProjectAssetToolProvider(deps),
    deps,
    listQueries,
    readQueries,
    createCommands,
    reviseCommands,
    enableCommands,
    setListResult: (value: Result<readonly ProjectAssetSummary[], DomainError>) => {
      listResult = value;
    },
    setReadResult: (value: Result<ProjectAssetReadSnapshot, DomainError>) => {
      readResultValue = value;
    },
    setCreateResult: (value: Result<ProjectAssetWriteSnapshot, DomainError>) => {
      createResult = value;
    },
    setReviseResult: (value: Result<ProjectAssetWriteSnapshot, DomainError>) => {
      reviseResult = value;
    },
    setEnableResult: (value: Result<ProjectAssetEnableSnapshot, DomainError>) => {
      enableResultValue = value;
    }
  };
}

function failure(result: Result<unknown, DomainError>): DomainError {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  return result.error;
}

function file(path: string, content = 'x'): { path: string; content: string } {
  return { path, content };
}

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_key: 'req-asset-1',
    kind: 'skill',
    files: [file('SKILL.md', '# 技能\n\n正文')],
    ...overrides
  };
}

test('project asset provider 暴露 5 条工具、读写 scope 与审计开关', () => {
  const w = world();
  const tools = w.provider.tools();

  assert.equal(w.provider.id, 'project-asset-tools');
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      PROJECT_ASSET_LIST_TOOL_NAME,
      PROJECT_ASSET_READ_TOOL_NAME,
      PROJECT_ASSET_CREATE_TOOL_NAME,
      PROJECT_ASSET_REVISE_TOOL_NAME,
      PROJECT_ASSET_SET_ENABLED_TOOL_NAME
    ]
  );
  assert.deepEqual(
    tools.map((tool) => tool.scope),
    [READ_SCOPE, READ_SCOPE, WRITE_SCOPE, WRITE_SCOPE, WRITE_SCOPE]
  );
  for (const tool of tools) {
    assert.equal(tool.omitAuditPayload, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get(PROJECT_ASSET_LIST_TOOL_NAME)!.inputSchema.required, []);
  assert.deepEqual(byName.get(PROJECT_ASSET_READ_TOOL_NAME)!.inputSchema.required, ['asset_id']);
  assert.deepEqual(byName.get(PROJECT_ASSET_CREATE_TOOL_NAME)!.inputSchema.required, [
    'request_key',
    'kind',
    'files'
  ]);
  assert.deepEqual(byName.get(PROJECT_ASSET_REVISE_TOOL_NAME)!.inputSchema.required, [
    'request_key',
    'asset_id',
    'files'
  ]);
  assert.deepEqual(byName.get(PROJECT_ASSET_SET_ENABLED_TOOL_NAME)!.inputSchema.required, [
    'request_key',
    'asset_id',
    'enabled'
  ]);
});

test('provider 拒绝相同的读 / 写 scope 与未知工具', async () => {
  const w = world();
  assert.throws(
    () =>
      createProjectAssetToolProvider({
        ...w.deps,
        scopes: { read: READ_SCOPE, write: READ_SCOPE }
      }),
    /distinct/
  );

  const error = failure(await w.provider.call('project.asset.nope', {}, ctx()));
  assert.equal(error.code, 'not_found');
  assert.match(error.message, /未知工具/);
});

test('身份只来自 ctx.grant，payload 不能覆盖绑定', async () => {
  const w = world();
  const result = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, {}, ctx());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.listQueries.length, 1);
  assert.equal(w.listQueries[0]!.actorId, ACTOR_ID);
  assert.equal(w.listQueries[0]!.actorVia, 'web');
  assert.equal(w.listQueries[0]!.sessionId, SESSION_ID);

  const injected = await w.provider.call(
    PROJECT_ASSET_LIST_TOOL_NAME,
    { actor_id: 'u-evil', project_id: 'prj-evil', session_id: 'ses-evil' },
    ctx()
  );
  const error = failure(injected);
  assert.equal(error.code, 'invalid');
  assert.match(error.message, /不支持的参数/);
  assert.match(error.message, /actor_id/);
  assert.equal(w.listQueries.length, 1);
  assert.equal(JSON.stringify(error).includes('u-evil'), false);

  const anonymous = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, {}, ctx({ actor: undefined }));
  const forbiddenError = failure(anonymous);
  assert.equal(forbiddenError.code, 'forbidden');
  assert.equal(w.listQueries.length, 1);
});

test('project.asset.list 传默认参数并从授权绑定补全项目上下文', async () => {
  const w = world();
  const result = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, {}, ctx());

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(w.listQueries[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    kind: null,
    includeDisabled: false,
    limit: 50
  });
  assert.deepEqual(result.value, { assets: [EFFECTIVE], truncated: false });
});

test('project.asset.list 防御性丢弃未生效项、按 kind 过滤并计算截断', async () => {
  const w = world();
  w.setListResult(ok([EFFECTIVE, DISABLED, SHADOWED]));

  const result = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, {}, ctx());
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, { assets: [EFFECTIVE], truncated: true });
});

test('project.asset.list 支持 include_disabled、kind 与 limit 边界', async () => {
  const w = world();
  w.setListResult(ok([EFFECTIVE, DISABLED, SHADOWED]));

  const all = await w.provider.call(
    PROJECT_ASSET_LIST_TOOL_NAME,
    { include_disabled: true, kind: 'skill', limit: 2 },
    ctx()
  );
  assert.ok(all.ok, JSON.stringify(all));
  assert.deepEqual(w.listQueries[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    kind: 'skill',
    includeDisabled: true,
    limit: 2
  });
  assert.deepEqual(all.value, { assets: [EFFECTIVE, SHADOWED], truncated: true });

  for (const limit of [0, 201, 1.5, '10']) {
    const bad = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, { limit }, ctx());
    assert.equal(failure(bad).code, 'invalid');
  }
  const badKind = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, { kind: 'binary' }, ctx());
  assert.equal(failure(badKind).code, 'invalid');
  assert.equal(w.listQueries.length, 1);
});

test('project.asset.list 不把回调里的额外字段透传出去', async () => {
  const w = world();
  const leaky = { ...EFFECTIVE, token: 'hunter2', absolutePath: '/srv/secret' };
  w.setListResult(ok([leaky as unknown as ProjectAssetSummary]));

  const result = await w.provider.call(PROJECT_ASSET_LIST_TOOL_NAME, {}, ctx());
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, { assets: [EFFECTIVE], truncated: false });
  assert.equal(JSON.stringify(result.value).includes('hunter2'), false);
  assert.equal(JSON.stringify(result.value).includes('/srv/secret'), false);
});

test('project.asset.read 默认只读清单，显式 path 才回单个文件', async () => {
  const w = world();
  const manifest = await w.provider.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1' },
    ctx()
  );
  assert.ok(manifest.ok, JSON.stringify(manifest));
  assert.deepEqual(w.readQueries[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    assetId: 'ast-1',
    path: null
  });
  assert.deepEqual(manifest.value, { asset: readSnapshot() });

  const content = '---\r\nname: my-skill\r\n---\r\n\t正文\n';
  const size = Buffer.byteLength(content, 'utf8');
  w.setReadResult(
    ok(
      readSnapshot({
        files: [{ path: 'SKILL.md', sha256: SHA, size }],
        file: { path: 'SKILL.md', content, size }
      })
    )
  );
  const read = await w.provider.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1', path: 'SKILL.md' },
    ctx()
  );
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual((read.value as { asset: ProjectAssetReadSnapshot }).asset.file, {
    path: 'SKILL.md',
    content,
    size
  });
});

test('project.asset.read 拒绝 digest 等绕过参数与越界路径', async () => {
  const w = world();
  for (const input of [
    { asset_id: 'ast-1', digest: SHA },
    { asset_id: 'ast-1', project_id: 'prj-evil' },
    { asset_id: '/etc/passwd' },
    { asset_id: 'ast-1', path: '/etc/passwd' },
    { asset_id: 'ast-1', path: '../secrets' },
    { asset_id: 'ast-1', path: 'a\\b.txt' },
    { asset_id: 'ast-1', path: 'a//b.txt' },
    { asset_id: 'ast-1', path: 'a/./b.txt' },
    { asset_id: 'ast-1', path: 'a/' }
  ]) {
    const result = await w.provider.call(PROJECT_ASSET_READ_TOOL_NAME, input, ctx());
    assert.equal(failure(result).code, 'invalid', JSON.stringify(input));
  }
  assert.equal(w.readQueries.length, 0);
});

test('project.asset.read 核实回调快照，不返回未请求的文件或越界内容', async () => {
  const w = world();
  w.setReadResult(ok(readSnapshot({ assetId: 'ast-other' })));
  let result = await w.provider.call(PROJECT_ASSET_READ_TOOL_NAME, { asset_id: 'ast-1' }, ctx());
  assert.equal(failure(result).code, 'unavailable');

  w.setReadResult(ok(readSnapshot({ file: { path: 'SKILL.md', content: 'hello', size: 5 } })));
  result = await w.provider.call(PROJECT_ASSET_READ_TOOL_NAME, { asset_id: 'ast-1' }, ctx());
  assert.equal(failure(result).code, 'unavailable');

  const content = 'hello';
  w.setReadResult(
    ok(
      readSnapshot({
        files: [{ path: 'SKILL.md', sha256: SHA, size: 5 }],
        file: { path: 'OTHER.md', content, size: 5 }
      })
    )
  );
  result = await w.provider.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1', path: 'SKILL.md' },
    ctx()
  );
  assert.equal(failure(result).code, 'unavailable');

  w.setReadResult(
    ok(
      readSnapshot({
        files: [{ path: 'SKILL.md', sha256: SHA, size: 99 }],
        file: { path: 'SKILL.md', content, size: 5 }
      })
    )
  );
  result = await w.provider.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1', path: 'SKILL.md' },
    ctx()
  );
  assert.equal(failure(result).code, 'unavailable');
});

test('project.asset.read 单文件内容上限 64 KiB 且错误不带正文 / 路径', async () => {
  const w = world();
  const content = 'a'.repeat(64 * 1024 + 1);
  w.setReadResult(
    ok(
      readSnapshot({
        files: [{ path: 'BIG.md', sha256: SHA, size: content.length }],
        file: { path: 'BIG.md', content, size: content.length }
      })
    )
  );

  const result = await w.provider.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1', path: 'BIG.md' },
    ctx()
  );
  const error = failure(result);
  assert.equal(error.code, 'invalid');
  assert.equal(error.message.includes('BIG.md'), false);
  assert.equal(error.message.includes('aaaa'), false);
});

test('project.asset.read 把回调异常与底层 unavailable 细节收成固定文案', async () => {
  const w = world();
  const throwing = createProjectAssetToolProvider({
    ...w.deps,
    readAsset: async () => {
      throw new Error('/srv/private/hunter2.md 读取失败');
    }
  });
  let result = await throwing.call(
    PROJECT_ASSET_READ_TOOL_NAME,
    { asset_id: 'ast-1' },
    ctx()
  );
  let error = failure(result);
  assert.equal(error.code, 'unavailable');
  assert.equal(error.message, '资产版本暂时无法读取');
  assert.equal(JSON.stringify(error).includes('hunter2'), false);

  w.setReadResult(err(unavailable('/srv/private/hunter2.md 不存在')));
  result = await w.provider.call(PROJECT_ASSET_READ_TOOL_NAME, { asset_id: 'ast-1' }, ctx());
  error = failure(result);
  assert.equal(error.code, 'unavailable');
  assert.equal(error.message, '资产版本暂时无法读取');
});

test('project.asset.create 传规范化命令、保留正文换行 / 制表符且不带项目参数', async () => {
  const w = world();
  const content = '第一行\r\n\t第二行\n';
  const result = await w.provider.call(
    PROJECT_ASSET_CREATE_TOOL_NAME,
    createInput({ files: [file('SKILL.md', content), file('nested/notes.md', '备注')] }),
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(w.createCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-asset-1',
    kind: 'skill',
    name: null,
    files: [
      { path: 'SKILL.md', content },
      { path: 'nested/notes.md', content: '备注' }
    ]
  });
  assert.deepEqual(result.value, { asset: writeSnapshot() });
});

test('project.asset.create 校验 name / kind / request_key 且错误不回显', async () => {
  const w = world();
  const cases: Record<string, unknown>[] = [
    createInput({ request_key: '' }),
    createInput({ request_key: 'x'.repeat(201) }),
    createInput({ kind: 'binary' }),
    createInput({ name: ' My Skill ' }),
    createInput({ name: 'My-Skill' }),
    createInput({ name: 'x'.repeat(65) }),
    createInput({ files: [] })
  ];
  for (const input of cases) {
    const result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, input, ctx());
    const error = failure(result);
    assert.equal(error.code, 'invalid');
    assert.equal(error.message.includes('My Skill'), false);
    assert.equal(error.message.includes('binary'), false);
  }
  assert.equal(w.createCommands.length, 0);
});

test('project.asset.create 强制文件边界：路径、重复、NUL、单文件与合计', async () => {
  const w = world();
  const tooMany = Array.from({ length: 201 }, (_, index) => file(`f${index}.md`));
  const overSingle = [file('big.md', 'a'.repeat(1024 * 1024 + 1))];
  const overTotal = Array.from({ length: 5 }, (_, index) =>
    file(`chunk${index}.md`, 'a'.repeat(900_000))
  );

  const cases: Record<string, unknown>[] = [
    createInput({ files: tooMany }),
    createInput({ files: overSingle }),
    createInput({ files: overTotal }),
    createInput({ files: [file('a.md'), file('a.md')] }),
    createInput({ files: [file('../escape.md')] }),
    createInput({ files: [file('/absolute.md')] }),
    createInput({ files: [file('a\\b.md')] }),
    createInput({ files: [file('a//b.md')] }),
    createInput({ files: [file('a/./b.md')] }),
    createInput({ files: [file('a/')] }),
    createInput({ files: [file('a.md', 'bad\u0000content')] }),
    createInput({ files: [{ path: 'a.md', content: 'x', mode: '755' }] })
  ];

  for (const input of cases) {
    const result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, input, ctx());
    assert.equal(failure(result).code, 'invalid');
  }
  assert.equal(w.createCommands.length, 0);
});

test('project.asset.create 不接受直接发布，收据字段必须成对且不带正文', async () => {
  const w = world();
  w.setCreateResult(ok(writeSnapshot({ published: true })));
  let result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, createInput(), ctx());
  assert.equal(failure(result).code, 'unavailable');

  w.setCreateResult(ok(writeSnapshot({ submissionId: null, submissionStatus: 'pending' })));
  result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, createInput(), ctx());
  assert.equal(failure(result).code, 'unavailable');

  w.setCreateResult(ok(writeSnapshot({ digest: 'abc' })));
  result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, createInput(), ctx());
  assert.equal(failure(result).code, 'unavailable');

  const leaky = {
    ...writeSnapshot(),
    files: [{ path: 'SKILL.md', content: 'hunter2' }],
    token: 'hunter2'
  } as unknown as ProjectAssetWriteSnapshot;
  w.setCreateResult(ok(leaky));
  result = await w.provider.call(PROJECT_ASSET_CREATE_TOOL_NAME, createInput(), ctx());
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, { asset: writeSnapshot() });
  assert.equal(JSON.stringify(result.value).includes('hunter2'), false);
});

test('project.asset.revise 绑定 asset_id 与请求键，允许已发布资产的新提交', async () => {
  const w = world();
  w.setReviseResult(ok(writeSnapshot({ published: true, submissionId: null, submissionStatus: null })));
  const result = await w.provider.call(
    PROJECT_ASSET_REVISE_TOOL_NAME,
    { request_key: 'req-revise-1', asset_id: 'ast-1', files: [file('SKILL.md', 'v2')] },
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(w.reviseCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-revise-1',
    assetId: 'ast-1',
    files: [{ path: 'SKILL.md', content: 'v2' }]
  });

  w.setReviseResult(ok(writeSnapshot({ assetId: 'ast-other' })));
  const mismatch = await w.provider.call(
    PROJECT_ASSET_REVISE_TOOL_NAME,
    { request_key: 'req-revise-2', asset_id: 'ast-1', files: [file('SKILL.md', 'v2')] },
    ctx()
  );
  assert.equal(failure(mismatch).code, 'unavailable');
});

test('project.asset.revise 拒绝 digest / 项目覆盖参数与非法文件', async () => {
  const w = world();
  for (const input of [
    { request_key: 'r', asset_id: 'ast-1', files: [file('a.md')], digest: SHA },
    { request_key: 'r', asset_id: 'ast-1', files: [file('a.md')], project_id: 'prj-evil' },
    { request_key: 'r', asset_id: 'ast-1' },
    { request_key: 'r', asset_id: 'ast-1', files: [file('../a.md')] }
  ]) {
    const result = await w.provider.call(PROJECT_ASSET_REVISE_TOOL_NAME, input, ctx());
    assert.equal(failure(result).code, 'invalid');
  }
  assert.equal(w.reviseCommands.length, 0);
});

test('project.asset.set_enabled 传布尔 / null 开关并核实响应', async () => {
  const w = world();
  for (const enabled of [true, false, null]) {
    w.setEnableResult(ok(enableSnapshot({ enabled: enabled ?? true, overridden: enabled !== null })));
    const result = await w.provider.call(
      PROJECT_ASSET_SET_ENABLED_TOOL_NAME,
      { request_key: `req-enable-${String(enabled)}`, asset_id: 'ast-1', enabled },
      ctx()
    );
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, {
      projectAsset: { assetId: 'ast-1', enabled: enabled ?? true, overridden: enabled !== null }
    });
  }
  assert.deepEqual(
    w.enableCommands.map((command) => command.enabled),
    [true, false, null]
  );

  w.setEnableResult(ok(enableSnapshot({ assetId: 'ast-other' })));
  const mismatch = await w.provider.call(
    PROJECT_ASSET_SET_ENABLED_TOOL_NAME,
    { request_key: 'req-enable-x', asset_id: 'ast-1', enabled: true },
    ctx()
  );
  assert.equal(failure(mismatch).code, 'unavailable');
});

test('project.asset.set_enabled 拒绝字符串开关、缺失值、未知键与未绑定身份', async () => {
  const w = world();
  for (const input of [
    { request_key: 'r', asset_id: 'ast-1', enabled: 'true' },
    { request_key: 'r', asset_id: 'ast-1' },
    { request_key: 'r', asset_id: 'ast-1', enabled: true, project_id: 'prj-evil' }
  ]) {
    const result = await w.provider.call(PROJECT_ASSET_SET_ENABLED_TOOL_NAME, input, ctx());
    assert.equal(failure(result).code, 'invalid');
  }
  const anonymous = await w.provider.call(
    PROJECT_ASSET_SET_ENABLED_TOOL_NAME,
    { request_key: 'r', asset_id: 'ast-1', enabled: true },
    ctx({ actor: undefined })
  );
  assert.equal(failure(anonymous).code, 'forbidden');
  assert.equal(w.enableCommands.length, 0);
});
