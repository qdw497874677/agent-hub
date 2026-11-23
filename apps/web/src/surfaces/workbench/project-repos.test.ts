import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_REPOS_MAX,
  REPO_DEFAULT_BRANCH,
  REPO_TOKEN_MAX,
  clearCredential,
  emptyRepoRow,
  repoCheckBlocksSave,
  repoCheckFailureLabel,
  repoCheckLine,
  repoCheckSummary,
  repoCredentialPatch,
  repoDiagnosticCodeLabel,
  repoDiagnosticDuration,
  repoDiagnosticFrom,
  repoDiagnosticRows,
  repoDiagnosticStageLabel,
  repoDiagnosticText,
  repoProbeAffected,
  repoProbeText,
  repoRowProblem,
  repoRowsProblem,
  repoRowsFrom,
  repoRowsValue,
  repoUrlPatch,
  repoNameFromUrl,
  cloneErrorHint,
  reposDirty,
  type ProjectRepoRow,
  type RepoCheckDiagnostic,
  type RepoCheckResult,
  type ReposCheck
} from './project-repos.ts';

const row = (over: Partial<ProjectRepoRow> = {}): ProjectRepoRow => ({
  id: '',
  name: 'api',
  url: 'git@github.com:acme/api.git',
  defaultBranch: 'main',
  credential: '',
  hasToken: false,
  clearToken: false,
  ...over
});

test('repoRowsFrom：老项目没有 repos / 形状不对 → 空清单', () => {
  assert.deepEqual(repoRowsFrom({ id: 'p1', name: 'x' }), []);
  assert.deepEqual(repoRowsFrom(null), []);
  assert.deepEqual(repoRowsFrom({ repos: 'nope' }), []);
  // 库里老行的 defaultBranch 可能是 null，读成空串（保存时回 main）
  assert.deepEqual(repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] }), [
    { id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: '', credential: '', hasToken: false, clearToken: false }
  ]);
});

test('repoRowsFrom：hasToken 只认 true，草稿里的令牌永远从空串开始（服务端不回明文）', () => {
  const [withToken, without] = repoRowsFrom({
    repos: [
      { id: 'repo_1', name: 'api', url: 'https://x/y.git', hasToken: true },
      { id: 'repo_2', name: 'web', url: 'https://x/web.git', hasToken: 'yes' }
    ]
  });
  assert.equal(withToken?.hasToken, true);
  assert.equal(withToken?.credential, '');
  assert.equal(without?.hasToken, false);
});

test('repoRowProblem：空 name / url 各自说清', () => {
  assert.equal(repoRowProblem(row({ name: '' }), [row({ name: '' })]), '写上仓库名（会用作组合工作目录里的子目录名）');
  assert.equal(repoRowProblem(row({ url: '' }), [row({ url: '' })]), '写上仓库地址');
});

test('repoRowProblem：仓库名规则 = 小写字母开头，字母数字和 -，最多 41 个字符', () => {
  const bad = (name: string) => repoRowProblem(row({ name }), [row({ name })]);
  assert.equal(bad('Api'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad('1api'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad('api_v2'), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad(`a${'b'.repeat(41)}`), '仓库名只能用小写字母、数字和 -，并且以字母开头');
  assert.equal(bad(`a${'b'.repeat(40)}`), null);
});

test('repoRowProblem：重名两行都报', () => {
  const rows = [row({ name: 'api' }), row({ name: 'api' })];
  assert.equal(repoRowProblem(rows[1]!, rows), '仓库名重复：api');
  assert.equal(repoRowsProblem(rows), '仓库名重复：api');
});

test('repoRowProblem：地址只认 http(s) / ssh / git@host:path', () => {
  const ok = (url: string) => repoRowProblem(row({ url }), [row({ url })]);
  assert.equal(ok('https://github.com/acme/api.git'), null);
  assert.equal(ok('http://git.example.com/api'), null);
  assert.equal(ok('ssh://git@github.com/acme/api.git'), null);
  assert.equal(ok('git@github.com:acme/api.git'), null);
  assert.equal(ok('/home/me/code/api'), '仓库地址要以 http(s):// 或 ssh:// 开头');
  assert.equal(ok('github.com/acme/api'), '仓库地址要以 http(s):// 或 ssh:// 开头');
});

test('repoRowProblem：最多 8 个仓库', () => {
  const rows = Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => row({ name: `repo-${i}`, url: `https://x/${i}` }));
  assert.equal(repoRowProblem(rows[0]!, rows), `一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`);
});

test('repoRowsValue：默认分支留空写 null（用仓库自己的默认分支），原本有 id 就带上', () => {
  assert.deepEqual(repoRowsValue([row({ id: 'repo_1', defaultBranch: '' }), row({ name: 'web', url: 'https://x/web.git', defaultBranch: '' })]), [
    { id: 'repo_1', name: 'api', url: 'git@github.com:acme/api.git', defaultBranch: REPO_DEFAULT_BRANCH },
    { name: 'web', url: 'https://x/web.git', defaultBranch: REPO_DEFAULT_BRANCH }
  ]);
  // 两端的空白不进请求
  assert.deepEqual(repoRowsValue([row({ name: ' api ', url: ' https://x/y ', defaultBranch: ' dev ' })]), [
    { name: 'api', url: 'https://x/y', defaultBranch: 'dev' }
  ]);
});

test('reposDirty：空默认分支和 main 等价，不算改动', () => {
  const saved = repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] });
  assert.equal(reposDirty(repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null }] }), saved), false);
  assert.equal(reposDirty([row({ id: 'repo_1', url: 'https://x/y.git', defaultBranch: 'dev' })], saved), true);
});

test('emptyRepoRow：新行没有 id，保存时才带上名字和地址', () => {
  const blank = emptyRepoRow();
  assert.deepEqual(blank, {
    id: '',
    name: '',
    url: '',
    defaultBranch: '',
    credential: '',
    hasToken: false,
    clearToken: false
  });
  assert.equal(repoRowProblem(blank, [blank]), '写上仓库名（会用作组合工作目录里的子目录名）');
  // 0 个仓库是合法状态（不绑仓库）
  assert.equal(repoRowsProblem([]), null);
});

test('repoNameFromUrl：https / scp 写法都能猜出子目录名，猜不出就空', () => {
  assert.equal(repoNameFromUrl('https://github.com/acme/api.git'), 'api');
  assert.equal(repoNameFromUrl('git@github.com:acme/api.git'), 'api');
  assert.equal(repoNameFromUrl('ssh://git@host/acme/web-app.git/'), 'web-app');
  assert.equal(repoNameFromUrl('https://github.com/acme/My_Repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl(''), '');
  assert.equal(repoNameFromUrl('https://github.com/'), '');
});

test('repoUrlPatch：名字还空着或还是自动填的，就跟着地址走；自己改过就不动', () => {
  assert.deepEqual(repoUrlPatch(row({ name: '', url: '' }), 'https://h/acme/api.git'), {
    url: 'https://h/acme/api.git',
    name: 'api'
  });
  assert.deepEqual(repoUrlPatch(row({ name: 'api', url: 'https://h/acme/api.git' }), 'https://h/acme/web.git'), {
    url: 'https://h/acme/web.git',
    name: 'web'
  });
  assert.deepEqual(repoUrlPatch(row({ name: 'backend', url: 'https://h/acme/api.git' }), 'https://h/acme/web.git'), {
    url: 'https://h/acme/web.git'
  });
  assert.deepEqual(repoUrlPatch(row({ name: '', url: '' }), 'https://github.com/'), { url: 'https://github.com/' });
});

test('cloneErrorHint：分支不存在 / 域名解析不了 / 没凭据各给一句可执行的建议', () => {
  assert.match(
    cloneErrorHint("下载仓库失败：Cloning into 'agent-hub'... fatal: Remote branch main not found in upstream origin") ?? '',
    /默认分支/
  );
  assert.match(cloneErrorHint('fatal: Could not resolve host: github.com') ?? '', /镜像地址|clone 好/);
  assert.match(cloneErrorHint('fatal: Authentication failed for repo') ?? '', /凭据/);
  assert.equal(cloneErrorHint('下载仓库失败：磁盘满了'), null);
});

const checked = (over: Partial<RepoCheckResult> = {}): RepoCheckResult => ({
  name: 'api',
  url: 'git@github.com:acme/api.git',
  branch: null,
  ok: true,
  defaultBranch: 'master',
  message: null,
  ...over
});

const checkOf = (over: Partial<ReposCheck> = {}): ReposCheck => ({
  workerId: 'worker-1',
  workerLabel: '本机',
  unavailable: null,
  results: [checked()],
  ...over
});

test('仓库检查 · 全部通过：报出真正的默认分支，不挡保存', () => {
  const check = checkOf();
  // 用户没指定分支时顺手告诉实际用的是哪个 —— 这就是「写死 main」踩过的坑
  assert.equal(repoCheckLine(checked()), '可以访问，默认分支是 master');
  assert.equal(repoCheckLine(checked({ defaultBranch: null })), '可以访问，默认分支是 未知');
  // 用户自己填了分支就没什么好补充的
  assert.equal(repoCheckLine(checked({ branch: 'main' })), null);
  assert.equal(repoCheckSummary(check), null);
  assert.equal(repoCheckBlocksSave(check), false);
  // 空清单（项目不绑仓库）也照常能存
  assert.equal(repoCheckSummary(checkOf({ results: [] })), null);
  assert.equal(repoCheckBlocksSave(checkOf({ results: [] })), false);
});

test('仓库检查 · 有失败：行内直接用后端那句话，总结说数量，挡住保存', () => {
  const failed = checked({ ok: false, branch: 'main', message: '远端没有 main 分支' });
  const check = checkOf({ results: [failed] });
  assert.equal(repoCheckLine(failed), '远端没有 main 分支');
  // 后端没给原因时行内不编话
  assert.equal(repoCheckLine(checked({ ok: false, message: null })), null);
  assert.equal(repoCheckSummary(check), '有 1 个仓库需要先处理');
  assert.equal(repoCheckBlocksSave(check), true);
});

test('仓库检查 · unavailable：原样转述没检查成，绝不能挡保存', () => {
  const unavailable = '现在没有在线的机器可以检查仓库';
  const check = checkOf({ unavailable, results: [checked({ ok: false, message: 'x' })] });
  assert.equal(repoCheckSummary(check), unavailable);
  // 没检查成 ≠ 仓库有问题：离线也要能改项目设置
  assert.equal(repoCheckBlocksSave(check), false);
});

test('仓库检查 · 混合：通过的那条不打扰，失败的那条仍然挡住保存', () => {
  const check = checkOf({
    results: [
      checked({ name: 'api' }),
      checked({ name: 'web', url: 'https://x/web.git', ok: false, message: '远端没有 main 分支' })
    ]
  });
  assert.equal(repoCheckSummary(check), '有 1 个仓库需要先处理');
  assert.equal(repoCheckBlocksSave(check), true);
  assert.equal(repoCheckLine(check.results[0]!), '可以访问，默认分支是 master');
  assert.equal(repoCheckLine(check.results[1]!), '远端没有 main 分支');
});

test('访问令牌 · 没填没点清除 → 补丁为空，保存不会抹掉已有令牌', () => {
  assert.deepEqual(repoCredentialPatch(row()), {});
  assert.deepEqual(repoCredentialPatch(row({ hasToken: true })), {});
  // 已被清空但没点清除（比如用户手删了输入框里的字）也算「不改」
  assert.deepEqual(repoCredentialPatch(row({ hasToken: true, credential: '   ' })), {});
});

test('访问令牌 · 这次填了值 → 带上（去两端空白）；显式清除 → 空串', () => {
  assert.deepEqual(repoCredentialPatch(row({ credential: ' glpat-abc ' })), { credential: 'glpat-abc' });
  assert.deepEqual(repoCredentialPatch(row({ hasToken: true, clearToken: true })), { credential: '' });
  // 兜底：两件事同时成立时保留敲进去的值（界面上填值会把清除态重置掉）
  assert.deepEqual(repoCredentialPatch(row({ credential: 'x', clearToken: true })), { credential: 'x' });
});

test('访问令牌 · clearCredential 是两态的：点一次进清除态，再点撤销回来', () => {
  const withToken = row({ id: 'repo_1', hasToken: true, credential: 'old-typed' });
  const cleared = { ...withToken, ...clearCredential(withToken) };
  assert.equal(cleared.clearToken, true);
  // 清除态不带旧的输入值，避免把用户敲的字当成要保存的新令牌
  assert.equal(cleared.credential, '');
  const undone = { ...cleared, ...clearCredential(cleared) };
  assert.equal(undone.clearToken, false);
  assert.equal(undone.credential, '');
  assert.deepEqual(repoCredentialPatch(undone), {});
});

test('访问令牌 · repoRowsValue 只在需要时带 credential，reposDirty 能看出令牌改动', () => {
  assert.deepEqual(repoRowsValue([row({ id: 'repo_1' })]), [
    { id: 'repo_1', name: 'api', url: 'git@github.com:acme/api.git', defaultBranch: 'main' }
  ]);
  assert.deepEqual(repoRowsValue([row({ id: 'repo_1', credential: 'glpat-abc' })]), [
    { id: 'repo_1', name: 'api', url: 'git@github.com:acme/api.git', defaultBranch: 'main', credential: 'glpat-abc' }
  ]);
  const saved = repoRowsFrom({ repos: [{ id: 'repo_1', name: 'api', url: 'https://x/y.git', defaultBranch: null, hasToken: true }] });
  assert.equal(reposDirty(saved, saved), false);
  // 只填令牌、别的都不动，也算改动（否则保存按钮一直是灰的）
  assert.equal(reposDirty([{ ...saved[0]!, credential: 'glpat-abc' }], saved), true);
  // 点清除也算改动
  assert.equal(reposDirty([{ ...saved[0]!, clearToken: true }], saved), true);
});

test('访问令牌 · 超过 512 个字符先拦下来（后端 1..512）', () => {
  const tooLong = 'x'.repeat(REPO_TOKEN_MAX + 1);
  assert.equal(repoRowProblem(row({ credential: tooLong }), [row({ credential: tooLong })]), `访问令牌最多 ${REPO_TOKEN_MAX} 个字符`);
  assert.equal(repoRowProblem(row({ credential: 'x'.repeat(REPO_TOKEN_MAX) }), [row({ credential: 'x'.repeat(REPO_TOKEN_MAX) })]), null);
});

test('单行检查 · 结论先说机器，再说仓库；成功带默认分支，失败贴后端原话、不重复分类', () => {
  const ok = checked({ branch: 'dev', credentialSource: 'saved' });
  assert.equal(repoProbeText(ok, 'omarchy'), '在 omarchy 上，可读取，分支 dev 存在 · 这次用的是已保存的令牌');
  assert.equal(repoProbeText(checked({ branch: null }), 'omarchy'), '在 omarchy 上，可读取，默认分支是 master');
  // 后端把凭据来源放在整份检查上而不是每条上，也要显示
  assert.equal(
    repoProbeText(checked({ branch: null }), 'omarchy', 'worker'),
    '在 omarchy 上，可读取，默认分支是 master · 这次没带令牌，交给机器上的 git 配置'
  );
  assert.equal(
    repoProbeText(checked({ ok: false, failureKind: 'branch_missing', branch: 'nope', message: '仓库里没有分支 nope，默认分支是 master' }), 'omarchy'),
    '在 omarchy 上，仓库里没有分支 nope，默认分支是 master'
  );
  assert.equal(
    repoProbeText(
      checked({ ok: false, failureKind: 'authentication', message: '认证失败：请检查仓库地址、令牌，或这台机器上的凭据' }),
      'omarchy'
    ),
    '在 omarchy 上，认证失败：请检查仓库地址、令牌，或这台机器上的凭据'
  );
  assert.equal(
    repoProbeText(checked({ ok: false, failureKind: 'unreachable', message: '连不上这个仓库' }), 'omarchy'),
    '在 omarchy 上，连不上这个仓库'
  );
  // 后端只给分类、没给话术时才用分类兜底
  assert.equal(repoProbeText(checked({ ok: false, failureKind: 'authentication', message: null }), 'omarchy'), '在 omarchy 上，认证没通过');
  // 旧后端没有 failureKind：只贴原话，不自己编「令牌失效」
  assert.equal(repoProbeText(checked({ ok: false, message: '远端没有 main 分支' }), null), '远端没有 main 分支');
  assert.equal(repoCheckFailureLabel('unreachable'), '连不上仓库');
  assert.equal(repoCheckFailureLabel(undefined), null);
});

test('单行检查 · 只有地址 / 分支 / 令牌变化会让结论过期，改名字不会', () => {
  assert.equal(repoProbeAffected({ name: 'web' }), false);
  assert.equal(repoProbeAffected({ url: 'https://x/y.git' }), true);
  assert.equal(repoProbeAffected({ defaultBranch: 'dev' }), true);
  assert.equal(repoProbeAffected({ credential: 'x' }), true);
  assert.equal(repoProbeAffected(clearCredential(row({ hasToken: true }))), true);
});

const diagnostic = (over: Partial<RepoCheckDiagnostic> = {}): RepoCheckDiagnostic => ({
  id: 'repo-check-401-9f2c',
  stage: 'git',
  code: 'http_401',
  transport: 'https',
  durationMs: 412,
  httpStatus: 401,
  ...over
});

test('诊断 · 服务端字段按契约收下；缺必填项、未知枚举或奇怪编号一律不显示', () => {
  assert.deepEqual(repoDiagnosticFrom({ ...diagnostic() }), diagnostic());
  // 没有 httpStatus 也能用
  assert.deepEqual(repoDiagnosticFrom({ ...diagnostic({ httpStatus: undefined }) }), {
    id: 'repo-check-401-9f2c',
    stage: 'git',
    code: 'http_401',
    transport: 'https',
    durationMs: 412
  });
  // 老后端 / 形状不对：没有诊断，别猜
  assert.equal(repoDiagnosticFrom(undefined), null);
  assert.equal(repoDiagnosticFrom(null), null);
  assert.equal(repoDiagnosticFrom('repo-check-401'), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), code: 'token_invalid' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), stage: 'network' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), transport: 'file' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: '' }), null);
  // 编号只接受短标识：带空格 / 换行的任意文本不进详情
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: 'repo check 401' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: 'repo-check\n401' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: 'a'.repeat(81) }), null);
  // 契约允许到 80，别把合法的编号挡掉（后端的 diag-<12 hex> 也是这个形状）
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: 'a'.repeat(80) })?.id.length, 80);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), id: 'diag-0a1b2c3d4e5f' })?.id, 'diag-0a1b2c3d4e5f');
});

test('诊断 · 耗时必须是有限非负数；异常值封顶，httpStatus 只认 401 / 403', () => {
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: -1 }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: Number.NaN }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: Number.POSITIVE_INFINITY }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: '412' }), null);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: 1_234.6 })?.durationMs, 1_235);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), durationMs: 999_999_999 })?.durationMs, 86_400_000);
  // 不认识的 HTTP 状态不影响其它字段，只是不显示
  assert.equal(repoDiagnosticFrom({ ...diagnostic({ httpStatus: undefined }), httpStatus: 500 })?.httpStatus, undefined);
  assert.equal(repoDiagnosticFrom({ ...diagnostic(), httpStatus: 403 })?.httpStatus, 403);
});

test('诊断 · 代码和阶段翻成人话，耗时按量级显示', () => {
  assert.equal(repoDiagnosticStageLabel('credential'), '凭据');
  assert.equal(repoDiagnosticStageLabel('git'), 'Git 访问');
  assert.equal(repoDiagnosticCodeLabel('http_401'), '服务器返回 401（未授权）');
  assert.equal(repoDiagnosticCodeLabel('credential_unavailable'), '无法读取已保存的令牌，未发起仓库检查');
  assert.equal(repoDiagnosticCodeLabel('worker_unavailable'), '机器未完成检查');
  assert.equal(repoDiagnosticCodeLabel('dns'), '域名解析失败');
  assert.equal(repoDiagnosticCodeLabel('unknown'), '原因未分类');
  assert.equal(repoDiagnosticDuration(0), '0 毫秒');
  assert.equal(repoDiagnosticDuration(412), '412 毫秒');
  assert.equal(repoDiagnosticDuration(1_500), '1.5 秒');
  assert.equal(repoDiagnosticDuration(2_000), '2 秒');
  assert.equal(repoDiagnosticDuration(12_400), '12 秒');
});

test('诊断 · 详情只放结构化字段和已展示过的机器 / 凭据，不含仓库地址与令牌', () => {
  const rows = repoDiagnosticRows(diagnostic(), { workerLabel: 'omarchy', credentialSource: 'draft' });
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['编号', 'repo-check-401-9f2c'],
      ['阶段', 'Git 访问'],
      ['原因', '服务器返回 401（未授权）'],
      ['代码', 'http_401'],
      ['传输', 'HTTPS'],
      ['耗时', '412 毫秒'],
      ['HTTP 状态', '401'],
      ['机器', 'omarchy'],
      ['凭据', '这次用的是填写的令牌']
    ]
  );
  // 没有机器 / 凭据来源时不多出空行
  assert.deepEqual(
    repoDiagnosticRows(diagnostic({ httpStatus: undefined }), { workerLabel: '  ', credentialSource: null }).map((row) => row.label),
    ['编号', '阶段', '原因', '代码', '传输', '耗时']
  );
  const text = repoDiagnosticText(diagnostic(), { workerLabel: 'omarchy', credentialSource: 'saved' });
  assert.equal(text.split('\n')[0], '仓库检查诊断');
  assert.match(text, /编号：repo-check-401-9f2c/);
  assert.match(text, /原因：服务器返回 401（未授权）/);
  // 稳定枚举跟人话并排，方便日志里搜
  assert.match(text, /代码：http_401/);
  assert.match(text, /凭据：这次用的是已保存的令牌/);
  // 地址、分支、令牌都不在可复制的文本里
  assert.doesNotMatch(text, /https?:|git@|acme\/api|e2e-check-secret/);
});

test('诊断 · 令牌读不出来或机器没跑完时，不声称令牌已经用过 / 送达', () => {
  const credential = diagnostic({ stage: 'credential', code: 'credential_unavailable', httpStatus: undefined });
  assert.deepEqual(
    repoDiagnosticRows(credential, { workerLabel: 'omarchy', credentialSource: 'saved' }).map((row) => [row.label, row.value]),
    [
      ['编号', 'repo-check-401-9f2c'],
      ['阶段', '凭据'],
      ['原因', '无法读取已保存的令牌，未发起仓库检查'],
      ['代码', 'credential_unavailable'],
      ['传输', 'HTTPS'],
      ['耗时', '412 毫秒']
    ]
  );
  assert.equal(
    repoProbeText(
      checked({ ok: false, failureKind: 'credential_unavailable', credentialSource: 'saved', diagnostic: credential }),
      'omarchy',
      'saved'
    ),
    '无法读取已保存的令牌，未发起仓库检查；请重新输入令牌再检查'
  );
  // 旧后端没有 diagnostic、只剩分类时，也不追加「这次用的是已保存的令牌」
  assert.equal(
    repoProbeText(
      checked({
        ok: false,
        failureKind: 'credential_unavailable',
        message: '这个仓库配了令牌，但密钥箱里找不到了；请重新输入令牌再检查',
        credentialSource: 'saved'
      }),
      'omarchy',
      'saved'
    ),
    '在 omarchy 上，这个仓库配了令牌，但密钥箱里找不到了；请重新输入令牌再检查'
  );

  const worker = diagnostic({ stage: 'worker', code: 'worker_unavailable', httpStatus: undefined });
  const workerRows = repoDiagnosticRows(worker, { workerLabel: 'omarchy', credentialSource: 'saved' });
  assert.deepEqual(workerRows.slice(-2).map((row) => [row.label, row.value]), [
    ['机器', 'omarchy'],
    ['凭据', '已保存的令牌（未确认送达仓库）']
  ]);
  assert.equal(
    repoProbeText(
      checked({
        ok: false,
        failureKind: 'unreachable',
        message: '这台机器暂时连不上，检查没有完成：请稍后重试或换一台机器',
        credentialSource: 'saved',
        diagnostic: worker
      }),
      'omarchy',
      'saved'
    ),
    '在 omarchy 上，这台机器暂时连不上，检查没有完成：请稍后重试或换一台机器'
  );
  assert.equal(
    repoProbeText(checked({ ok: false, failureKind: 'unreachable', message: null, diagnostic: worker }), 'omarchy', 'saved'),
    '在 omarchy 上，机器未完成检查'
  );
  // 成功 / Git 阶段仍按原来的方式说明凭据来源
  assert.equal(
    repoProbeText(
      checked({ ok: false, failureKind: 'authentication', message: '认证失败', credentialSource: 'saved', diagnostic: diagnostic() }),
      'omarchy',
      'saved'
    ),
    '在 omarchy 上，认证失败 · 这次用的是已保存的令牌'
  );
});

test('诊断 · 机器标签收成一行并限长，避免复制文本被撑散', () => {
  const single = repoDiagnosticRows(diagnostic(), { workerLabel: '  omarchy\n  box  ' });
  assert.equal(single.at(-1)?.value, 'omarchy box');
  const long = repoDiagnosticRows(diagnostic(), { workerLabel: 'm'.repeat(80) }).find((row) => row.label === '机器');
  assert.equal(long?.value, `${'m'.repeat(47)}…`);
  assert.equal(long?.value.length, 48);
});
