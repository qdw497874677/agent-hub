import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createProjectGitHttpsProbe,
  type ProjectGitHttpsProbeOptions
} from './project-git-https-probe.ts';

const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const SERVICE_LINE = '# service=git-upload-pack';
const OID = '1'.repeat(40);

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

type ResponseBody = ConstructorParameters<typeof Response>[0];

function pkt(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

function flush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function advertisement(input: {
  readonly refs?: ReadonlyArray<readonly [string, string]>;
  readonly caps?: string;
} = {}): Buffer {
  const caps = input.caps ?? 'multi_ack thin-pack symref=HEAD:refs/heads/main agent=git/2.43';
  const refs = input.refs ?? [
    ['HEAD', OID],
    ['refs/heads/main', OID],
    ['refs/heads/dev', OID]
  ];
  const parts: Buffer[] = [pkt(`${SERVICE_LINE}\n`), flush()];
  refs.forEach(([name, oid], index) => {
    const capsPart = index === 0 ? `\0${caps}` : '';
    parts.push(pkt(`${oid} ${name}${capsPart}\n`));
  });
  parts.push(flush());
  return Buffer.concat(parts);
}

function responding(
  body: Buffer | ReadableStream<Uint8Array>,
  init?: ResponseInit,
  calls?: FetchCall[]
): typeof fetch {
  return (async (input: string | URL | Request, fetchInit?: RequestInit) => {
    if (calls !== undefined) {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init: fetchInit ?? {}
      });
    }
    return new Response(body as unknown as ResponseBody, init ?? {
      status: 200,
      headers: { 'content-type': ADVERTISEMENT_CONTENT_TYPE }
    });
  }) as unknown as typeof fetch;
}

function probeWith(fetchImpl: typeof fetch, extra: Partial<ProjectGitHttpsProbeOptions> = {}) {
  return createProjectGitHttpsProbe({
    allowedOrigins: ['https://git.example.com'],
    fetchImpl,
    ...extra
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function headersOf(call: FetchCall): Headers {
  return new Headers(call.init.headers ?? {});
}

test('探测：解析 v0 广告，精确报告默认分支与分支是否存在，只发 Basic Authorization', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls));
  try {
    const result = await probe.check({
      url: 'https://git.example.com/org/repo.git',
      branch: 'main',
      authorization: 'Basic dXNlcjpwYXNz'
    });
    assert.deepEqual(result, { reachable: true, defaultBranch: 'main', branchExists: true, message: null });

    assert.equal(calls.length, 1);
    const call = calls[0] as FetchCall;
    assert.equal(call.url, 'https://git.example.com/org/repo.git/info/refs?service=git-upload-pack');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    // 注入的 fetchImpl 会拿到 createMcpEgress 的私有 dispatcher（父级 E2E 可据此走真实 TLS）。
    assert.notEqual((call.init as RequestInit & { dispatcher?: unknown }).dispatcher, undefined);
    const headers = headersOf(call);
    assert.equal(headers.get('accept'), ADVERTISEMENT_CONTENT_TYPE);
    assert.equal(headers.get('authorization'), 'Basic dXNlcjpwYXNz');
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization']);
  } finally {
    await probe.close();
  }
});

test('探测：结尾斜杠被收敛，不会拼出双斜杠', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls));
  try {
    const result = await probe.check({
      url: 'https://git.example.com/org/repo.git/',
      branch: 'dev',
      authorization: ''
    });
    assert.equal(result.branchExists, true);
    assert.equal((calls[0] as FetchCall).url, 'https://git.example.com/org/repo.git/info/refs?service=git-upload-pack');
    assert.equal(headersOf(calls[0] as FetchCall).has('authorization'), false);
  } finally {
    await probe.close();
  }
});

test('探测：分支按完整 ref 精确匹配，不做后缀 / 标签推断', async () => {
  const body = advertisement({
    refs: [
      ['HEAD', OID],
      ['refs/heads/mainline', OID],
      ['refs/tags/main', OID]
    ]
  });
  const probe = probeWith(responding(body));
  try {
    const branch = (value: string): Promise<boolean> =>
      probe
        .check({ url: 'https://git.example.com/r', branch: value, authorization: '' })
        .then((result) => result.branchExists);

    assert.equal(await branch('main'), false);
    assert.equal(await branch('ain'), false);
    assert.equal(await branch('mainline'), true);
    assert.equal(await branch('refs/heads/mainline'), true);
    assert.equal(await branch('heads/mainline'), false);
    assert.equal(await branch('refs/tags/main'), false);
  } finally {
    await probe.close();
  }
});

test('探测：没有 HEAD symref 时不猜默认分支；默认分支按 symref 证据取', async () => {
  const noSymref = advertisement({ caps: 'multi_ack', refs: [['HEAD', OID], ['refs/heads/trunk', OID]] });
  const probe = probeWith(responding(noSymref));
  try {
    const result = await probe.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.equal(result.reachable, true);
    assert.equal(result.defaultBranch, null);
    assert.equal(result.branchExists, true);
  } finally {
    await probe.close();
  }

  const badSymref = advertisement({
    caps: 'symref=HEAD:refs/heads/../secret',
    refs: [['HEAD', OID], ['refs/heads/main', OID]]
  });
  const badProbe = probeWith(responding(badSymref));
  try {
    const result = await badProbe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.defaultBranch, null);
    assert.equal(result.branchExists, true);
  } finally {
    await badProbe.close();
  }

  // symref 指向一个本次广告里不存在的 heads ref：没有证据，不能当默认分支。
  const contradictory = advertisement({
    caps: 'symref=HEAD:refs/heads/main',
    refs: [['HEAD', OID], ['refs/heads/other', OID]]
  });
  const contradictoryProbe = probeWith(responding(contradictory));
  try {
    const result = await contradictoryProbe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.reachable, true);
    assert.equal(result.defaultBranch, null);
    assert.equal(result.branchExists, false);
  } finally {
    await contradictoryProbe.close();
  }
});

test('探测：空的 refs 段（空仓库）可达但默认分支不可用', async () => {
  const probe = probeWith(responding(Buffer.concat([pkt(`${SERVICE_LINE}\n`), flush(), flush()])));
  try {
    const result = await probe.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.deepEqual(result, { reachable: true, defaultBranch: null, branchExists: false, message: null });
  } finally {
    await probe.close();
  }
});

test('探测：old / dumb / protocol v2 一律诚实报不可用', async () => {
  const cases: Buffer[] = [
    Buffer.from('ref: refs/heads/main\tHEAD\n', 'utf8'),
    Buffer.concat([pkt('version 2\n'), flush()]),
    Buffer.concat([pkt(`${SERVICE_LINE}\n`), Buffer.from('0001', 'ascii')])
  ];
  for (const body of cases) {
    const calls: FetchCall[] = [];
    const probe = probeWith(responding(body, {
      status: 200,
      headers: { 'content-type': ADVERTISEMENT_CONTENT_TYPE }
    }, calls));
    try {
      const result = await probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
      assert.equal(result.reachable, false);
      assert.equal(result.message, '仓库不支持 Smart HTTP 的 Git 广告协议');
      assert.equal(calls.length, 1);
    } finally {
      await probe.close();
    }
  }
});

test('探测：非 Smart HTTP 的 content-type / 非 200 状态都回固定安全文案', async () => {
  const plain = probeWith(responding(Buffer.from('ok'), {
    status: 200,
    headers: { 'content-type': 'text/plain' }
  }));
  try {
    const result = await plain.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.equal(result.message, '仓库不支持 Smart HTTP 的 Git 广告协议');
  } finally {
    await plain.close();
  }

  // 合法参数忽略；近似后缀不认。
  const withParams = probeWith(responding(advertisement(), {
    status: 200,
    headers: { 'content-type': 'APPLICATION/X-GIT-UPLOAD-PACK-ADVERTISEMENT; charset=utf-8' }
  }));
  try {
    const result = await withParams.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.reachable, true);
  } finally {
    await withParams.close();
  }

  const lookalike = probeWith(responding(advertisement(), {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement-evil' }
  }));
  try {
    const result = await lookalike.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.reachable, false);
    assert.equal(result.message, '仓库不支持 Smart HTTP 的 Git 广告协议');
  } finally {
    await lookalike.close();
  }

  const missing = probeWith(responding(Buffer.from('not found'), { status: 404 }));
  try {
    const result = await missing.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.equal(result.message, '仓库不存在或无权访问');
  } finally {
    await missing.close();
  }

  const denied = probeWith(responding(Buffer.from('denied'), { status: 401 }));
  try {
    const result = await denied.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.equal(result.message, '仓库需要有效的访问凭据');
  } finally {
    await denied.close();
  }
});

test('探测：截断的广告不当成可达', async () => {
  const truncated = Buffer.concat([pkt(`${SERVICE_LINE}\n`), flush(), pkt(`${OID} HEAD\0symref=HEAD:refs/heads/main\n`)]);
  const probe = probeWith(responding(truncated));
  try {
    const result = await probe.check({ url: 'https://git.example.com/r', branch: null, authorization: '' });
    assert.equal(result.reachable, false);
    assert.equal(result.message, '仓库返回的 Git 广告无法识别');
  } finally {
    await probe.close();
  }
});

test('探测：URL 只接受允许 origin 的 HTTPS，拒绝 userinfo / query / fragment / 元数据', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls));
  try {
    const cases: Array<[string, string]> = [
      ['http://git.example.com/r', '仓库地址必须使用 HTTPS'],
      ['ftp://git.example.com/r', '仓库地址必须使用 HTTPS'],
      ['https://user:pass@git.example.com/r', '仓库地址不能带用户名或密码'],
      ['https://git.example.com/r?x=1', '仓库地址不能带查询参数或片段'],
      ['https://git.example.com/r#frag', '仓库地址不能带查询参数或片段'],
      ['https://other.example.com/r', '仓库地址不在允许的范围内'],
      ['https://git.example.com.evil.test/r', '仓库地址不在允许的范围内'],
      ['https://127.0.0.1/r', '仓库地址不在允许的范围内'],
      ['https://metadata.google.internal/r', '仓库地址不在允许的范围内'],
      ['not a url', '仓库地址不是合法的 URL']
    ];
    for (const [url, message] of cases) {
      const result = await probe.check({ url, branch: null, authorization: '' });
      assert.equal(result.reachable, false, url);
      assert.equal(result.message, message, url);
    }
    assert.equal(calls.length, 0);
  } finally {
    await probe.close();
  }
});

test('探测：私网只给测试 loopback 开关，任意私网 / 元数据地址仍拒绝', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls), {
    allowedOrigins: [
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://metadata.google.internal',
      'https://169.254.169.254'
    ],
    testOnlyAllowLoopback: true
  });
  try {
    const loopback = await probe.check({ url: 'https://127.0.0.1/r', branch: 'main', authorization: '' });
    assert.equal(loopback.reachable, true);
    assert.equal(calls.length, 1);

    for (const url of [
      'https://10.0.0.5/r',
      'https://metadata.google.internal/r',
      'https://169.254.169.254/latest/meta-data'
    ]) {
      const result = await probe.check({ url, branch: null, authorization: '' });
      assert.equal(result.reachable, false, url);
      assert.equal(result.message, '仓库地址不在允许的范围内', url);
    }
    assert.equal(calls.length, 1);
  } finally {
    await probe.close();
  }
});

test('探测：allowedOrigins 必须是精确 HTTPS origin，不接受通配 / 路径 / 明文', () => {
  for (const allowedOrigins of [
    ['https://*.example.com'],
    ['http://example.com'],
    ['https://example.com/path'],
    ['https://user:pass@example.com'],
    ['not a url']
  ]) {
    assert.throws(
      () => createProjectGitHttpsProbe({ allowedOrigins, fetchImpl: responding(advertisement()) }),
      /allowedOrigins/
    );
  }
});

test('探测：只接受单行 Basic Authorization，CRLF / 其它 scheme 在发请求前拒绝', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls));
  try {
    for (const authorization of ['Basic abc\r\nX-Injected: yes', 'Bearer token', 'Basic ', 'Basic !!!']) {
      const result = await probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization });
      assert.equal(result.reachable, false, authorization);
      assert.equal(result.message, '仓库凭据格式不正确', authorization);
    }
    assert.equal(calls.length, 0);
  } finally {
    await probe.close();
  }
});

test('探测：字节 / 包 / 行数上限生效，超限回固定文案', async () => {
  const body = advertisement();
  const byteProbe = probeWith(responding(body), { maxBytes: 40 });
  try {
    const result = await byteProbe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.message, '仓库返回的 Git 广告超出上限');
  } finally {
    await byteProbe.close();
  }

  const lineProbe = probeWith(responding(body), { maxLineBytes: 8 });
  try {
    const result = await lineProbe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.message, '仓库返回的 Git 广告超出上限');
  } finally {
    await lineProbe.close();
  }

  const packetProbe = probeWith(responding(body), { maxPackets: 1 });
  try {
    const result = await packetProbe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.message, '仓库返回的 Git 广告超出上限');
  } finally {
    await packetProbe.close();
  }
});

test('探测：超时回固定文案，且会取消响应流', async () => {
  let cancelled = false;
  const never = new ReadableStream<Uint8Array>({
    start() {},
    cancel() {
      cancelled = true;
    }
  });
  const probe = probeWith(responding(never), { timeoutMs: 25 });
  try {
    const result = await probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(result.reachable, false);
    assert.equal(result.message, '连接仓库超时');
    await tick();
    assert.equal(cancelled, true);
  } finally {
    await probe.close();
  }
});

test('探测：容量满时立即回安全繁忙结果，不排队也不保留请求', async () => {
  let active = 0;
  let calls = 0;
  const releases: Array<() => void> = [];
  const fetchImpl = (async () => {
    calls += 1;
    active += 1;
    await new Promise<void>((resolve) => {
      releases.push(() => {
        active -= 1;
        resolve();
      });
    });
    return new Response(advertisement() as unknown as ResponseBody, {
      status: 200,
      headers: { 'content-type': ADVERTISEMENT_CONTENT_TYPE }
    });
  }) as unknown as typeof fetch;

  const probe = probeWith(fetchImpl, { maxConcurrent: 1 });
  try {
    const first = probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    await tick();
    assert.equal(active, 1);
    assert.equal(calls, 1);

    const busy = await probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    assert.equal(busy.reachable, false);
    assert.equal(busy.message, '仓库检查繁忙，请稍后再试');
    assert.equal(active, 1);
    assert.equal(calls, 1);

    (releases.shift() as () => void)();
    await first;
    assert.equal(active, 0);

    const third = probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
    await tick();
    assert.equal(active, 1);
    (releases.shift() as () => void)();
    const result = await third;
    assert.equal(result.reachable, true);
    assert.equal(calls, 2);
  } finally {
    await probe.close();
  }
});

test('探测：close() 幂等，关闭后不再发请求', async () => {
  const calls: FetchCall[] = [];
  const probe = probeWith(responding(advertisement(), undefined, calls));
  await probe.close();
  await probe.close();
  const result = await probe.check({ url: 'https://git.example.com/r', branch: 'main', authorization: '' });
  assert.equal(result.reachable, false);
  assert.equal(result.message, '仓库检查已关闭');
  assert.equal(calls.length, 0);
});
