import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHubClient, HubClientError, parseHubBase, readProfile, removeProfile, resolveConnection, writeProfile } from './ahub-client.ts';
import type { HubClient } from './ahub-client.ts';
import { checkpointStore } from './ahub-checkpoint.ts';
import type { CheckpointKind, CheckpointReceipt, CheckpointTarget } from './ahub-checkpoint.ts';
import { readHiddenToken, redactSecrets } from './workbench-mcp.ts';

type Row = Record<string, unknown>;
type Result = Row & { status: string };
type IO = {
  env: NodeJS.ProcessEnv; input: NodeJS.ReadStream; out: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>; err: Pick<NodeJS.WriteStream, 'write'>;
  fetch?: typeof fetch; profileDir?: string; stateDir?: string; signal?: AbortSignal;
};
const HELP = `用法：node scripts/ahub.ts <命令> [--profile <name>] [--json]
  auth login --hub <url> [--token-stdin] | auth status | auth logout
  project list | task list --project <id> | task show <id>
  task create --project <id> --title <title>
  doctor --task <id> [--worker <id>] [--agent <id>]
  session start --task <id> --worker <id> --workspace <id> --agent <id> [--model <id>]
  session show <id> | session send <id> --stdin [--wait] [--timeout <seconds>]
  session wait <id> --turn <n> [--timeout <seconds>]
  operation status <id>
交互终端可省略 task create 的项目和 session start 的目标参数，按编号选择。
HTTP 仅用于显式允许的回环地址（--allow-http）。不接受命令行明文令牌。`;

class CliError extends Error {
  constructor(readonlyResult: Result, exit: number) {
    super(typeof readonlyResult.nextAction === 'string' ? readonlyResult.nextAction : readonlyResult.status);
    this.result = readonlyResult;
    this.exit = exit;
  }
  readonly result: Result;
  readonly exit: number;
}
const fail = (status: string, code: string, nextAction: string, exit: number, fields: Row = {}): never => {
  throw new CliError({ ...fields, status, code, nextAction }, exit);
};
const usage = (message: string): never => fail('error', 'USAGE', message, 2);
const protocol = (): never => { throw new HubClientError('protocol', 'Invalid Hub response'); };
const unknown = (fields: Row, next = '先对账，不要补发同一操作。'): never => fail('unknown', 'RESULT_UNKNOWN', next, 6, fields);
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : protocol();
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : protocol();
const str = (value: unknown): string => typeof value === 'string' ? value : protocol();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const serverId = (value: unknown): string => typeof value === 'string' && idPattern.test(value) ? value : protocol();
const userId = (value: string | undefined, label: string): string => value && idPattern.test(value) ? value : usage(`请传完整且有效的 ${label}。`);
const integer = (value: unknown, min: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : protocol();
const numeric = (value: string | undefined, min: number, max: number, label: string): number => {
  const n = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : usage(`${label} 必须是 ${min}–${max} 的整数。`);
};
const pathId = (value: string) => encodeURIComponent(value);
const select = (r: Row, keys: readonly string[]): Row => Object.fromEntries(keys.filter((k) => typeof r[k] === 'string' || typeof r[k] === 'number' || r[k] === null).map((k) => [k, r[k]]));

type Choice = { id: string; label: string; blocked?: boolean };
const choice = (entry: Row, key: string, label: string): Choice => {
  const id = serverId(entry[key]);
  const name = typeof entry[label] === 'string' ? entry[label].replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 160) : '';
  return { id, label: name || id };
};
const localCancel = (): never => fail('cancelled_locally', 'LOCAL_CANCELLED', '已取消选择，未向 Hub 发送写请求。', 130);

async function withPicker<T>(io: IO, token: string, work: (picker: {
  choose(label: string, choices: Choice[], provided?: string): Promise<Choice>;
  confirm(action: string, selection: Choice[]): Promise<void>;
}) => Promise<T>): Promise<T> {
  const lines = createInterface({ input: io.input, terminal: false });
  const entries = lines[Symbol.asyncIterator]();
  const close = () => lines.close();
  io.signal?.addEventListener('abort', close, { once: true });
  const say = (text: string) => io.err.write(redactSecrets(text, token));
  const read = async () => {
    if (io.signal?.aborted) return localCancel();
    const next = await entries.next();
    if (next.done || io.signal?.aborted || next.value.trim() === '0') return localCancel();
    return next.value.trim();
  };
  try {
    return await work({
      async choose(label, choices, provided) {
        if (provided !== undefined) {
          const found = choices.find((item) => item.id === provided && !item.blocked);
          if (!found) return fail('error', 'TARGET_NOT_AVAILABLE', `指定的${label}不在可用匹配范围；检查权限、归属或就绪状态。`, 2);
          return found;
        }
        if (!choices.some((item) => !item.blocked)) return fail('error', 'NO_TARGET', `没有可选的${label}；请在 Hub 检查项目、工作目录和运行时就绪状态。`, 2);
        const counts = new Map<string, number>();
        for (const item of choices) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
        say(`\n选择${label}：\n`);
        choices.forEach((item, index) => say(`  ${index + 1}. ${item.label}${counts.get(item.label)! > 1 ? ` [${item.id}]` : ''}${item.blocked ? '（不可用）' : ''}\n`));
        for (;;) {
          say('输入序号，0 取消：');
          const value = await read();
          const selected = /^\d+$/.test(value) ? choices[Number(value) - 1] : undefined;
          if (selected && !selected.blocked) return selected;
          say('请输入可用选项的序号。\n');
        }
      },
      async confirm(action, selection) {
        say(`\n${selection.map((item) => `${item.label} [${item.id}]`).join(' → ')}\n确认${action}？[y/N] `);
        if (!/^y(?:es)?$/i.test(await read())) return localCancel();
      }
    });
  } finally {
    io.signal?.removeEventListener('abort', close);
    close();
  }
}

const globalFlags = { profile: 'value', json: 'switch', 'allow-http': 'switch' } as const;
type Flag = 'value' | 'switch';
const options: Record<string, { flags?: Record<string, Flag>; args?: number }> = {
  'auth login': { flags: { hub: 'value', 'token-stdin': 'switch' } }, 'auth status': {}, 'auth logout': {},
  'project list': {}, 'task list': { flags: { project: 'value' } }, 'task show': { args: 1 },
  'task create': { flags: { project: 'value', title: 'value' } },
  doctor: { flags: { task: 'value', worker: 'value', agent: 'value' } },
  'session start': { flags: { task: 'value', worker: 'value', workspace: 'value', agent: 'value', model: 'value' } },
  'session show': { args: 1 }, 'session send': { args: 1, flags: { stdin: 'switch', wait: 'switch', timeout: 'value' } },
  'session wait': { args: 1, flags: { turn: 'value', timeout: 'value' } }, 'operation status': { args: 1 }
};
function parse(argv: string[]) {
  const cmd = argv[0] === 'doctor' ? 'doctor' : argv.slice(0, 2).join(' ');
  if (!Object.hasOwn(options, cmd)) return usage('命令不支持；用 --help 查看用法。');
  const spec = options[cmd]!;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const allowed: Record<string, Flag> = { ...globalFlags, ...spec.flags };
  for (let i = cmd === 'doctor' ? 1 : 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { if (arg.startsWith('-')) usage('不支持短选项。'); positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!Object.hasOwn(allowed, key) || flags.has(key)) usage('存在未知或重复选项；用 --help 查看用法。');
    if (allowed[key] === 'switch') flags.set(key, 'true');
    else {
      const val = argv[++i];
      if (!val || val.startsWith('--')) return usage('缺少选项值。');
      flags.set(key, val);
    }
  }
  if (positional.length !== (spec.args ?? 0)) usage('位置参数数量不正确。');
  return { cmd, flags, positional };
}

async function stdin(input: NodeJS.ReadStream, max: number, label: string): Promise<string> {
  if (input.isTTY) return usage(`${label}请从文件或管道输入。`);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > max) return usage(`${label}超过大小限制。`);
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return usage(`${label}必须是 UTF-8。`); }
}

function readMe(value: unknown) {
  const me = row(value), user = row(me.user), token = row(me.token);
  const userId = serverId(user.id), tokenId = serverId(token.id);
  const caps = Array.isArray(me.capabilities) ? new Set(me.capabilities.filter((key): key is string => typeof key === 'string')) : new Set<string>();
  return { userId, tokenId, caps, userName: str(user.name), tokenName: str(token.name) };
}

function need(caps: Set<string>, feature: string) {
  if (!caps.has(feature)) fail('unsupported', 'HUB_FEATURE_MISSING', '此 Hub 不支持该契约；请升级 Hub。没有发送写请求。', 6, { feature });
}

function mapError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof HubClientError) {
    if (error.kind === 'http' && (error.status === 401 || error.status === 403 || error.status === 404)) {
      return new CliError({ status: 'error', code: `HTTP_${error.status}`, nextAction: '检查令牌是否有效、作用域是否足够，以及资源是否可见。' }, 3);
    }
    if (error.kind === 'configuration' || error.kind === 'storage') return new CliError({ status: 'error', code: error.kind.toUpperCase(), nextAction: '检查本地配置、HTTPS/回环地址和私有文件权限。' }, 2);
    return new CliError({ status: 'error', code: error.status ? `HTTP_${error.status}` : error.kind.toUpperCase(), nextAction: '检查 Hub 连接或参数，再查询已知资源。' }, error.kind === 'http' && (error.status ?? 500) < 500 ? 2 : 6);
  }
  return new CliError({ status: 'error', code: 'LOCAL_ERROR', nextAction: '检查本机输入、连接及私有状态目录。' }, 2);
}

function exactResult(value: unknown, sessionId: string, turn: number, expected?: CheckpointReceipt) {
  const r = row(value);
  if (r.sessionId !== sessionId || r.turn !== turn) return protocol();
  if (!['pending', 'terminal', 'unknown'].includes(String(r.status)) || typeof r.outcomeUnknown !== 'boolean') return protocol();
  const seq = r.promptSeq === null ? null : integer(r.promptSeq, 1);
  const deliveryId = r.deliveryId === null ? null : serverId(r.deliveryId);
  const fields = { sessionId, turn, ...(seq === null ? {} : { seq }), ...(deliveryId === null ? {} : { deliveryId }) };
  const state = r.deliveryState;
  if (![null, 'queued', 'sending', 'delivered', 'undelivered', 'cancelled', 'held'].includes(state as string | null)) return protocol();
  if (r.outcomeUnknown || r.status === 'unknown' || seq === null || deliveryId === null ||
      (expected && (seq !== expected.seq || deliveryId !== expected.deliveryId))) return unknown(fields, '这一轮缺少可核对的送达或结束证据；先核对会话，勿补发。');
  if (r.status === 'pending') return { terminal: false, fields, deliveryState: state } as const;
  if (state === 'undelivered' || state === 'cancelled') {
    if (r.outcome !== null || r.endedSeq !== null) return unknown(fields);
    return fail(state, state === 'undelivered' ? 'UNDELIVERED' : 'CANCELLED', '本轮未执行；检查会话，不会自动重发。', 4, fields);
  }
  if (integer(r.endedSeq, 1) <= seq) return unknown(fields);
  if (r.outcome === 'done') return { terminal: true, fields } as const;
  if (r.outcome === 'failed' || r.outcome === 'stopped' || r.outcome === 'interrupted') {
    return fail(r.outcome, r.outcome.toUpperCase(), '本轮已结束；查看会话以决定是否继续。', 4, fields);
  }
  return unknown(fields);
}

async function waitTurn(client: HubClient, sessionId: string, turn: number, seconds: number, signal?: AbortSignal, expected?: CheckpointReceipt, operationId?: string): Promise<Result> {
  const deadline = Date.now() + seconds * 1000;
  const budget = AbortSignal.timeout(seconds * 1000);
  const stop = signal ? AbortSignal.any([signal, budget]) : budget;
  const identity = { sessionId, turn, ...(operationId ? { operationId } : {}), ...(expected?.seq ? { seq: expected.seq } : {}), ...(expected?.deliveryId ? { deliveryId: expected.deliveryId } : {}) };
  let delay = 1000;
  let last: Result | undefined;
  let failures = 0;
  while (!stop.aborted) {
    try {
      const data = exactResult(await client.request(`/sessions/${pathId(sessionId)}/turns/${turn}`, { signal: stop }), sessionId, turn, expected);
      if (data.terminal) return { ...identity, ...data.fields, status: 'done' };
      last = { ...identity, ...data.fields, deliveryState: data.deliveryState, status: 'timeout' };
      failures = 0;
      delay = 1000;
    } catch (error) {
      if (stop.aborted) break;
      if (error instanceof CliError) throw new CliError({ ...identity, ...error.result }, error.exit);
      if (!(error instanceof HubClientError) || (!error.retryable && error.kind !== 'timeout')) {
        const mapped = mapError(error);
        throw new CliError({ ...identity, ...mapped.result }, mapped.exit);
      }
      failures++;
      delay = Math.max(Math.min(delay * 2, 8000), error.retryAfterMs ?? 0);
    }
    try { await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), undefined, { signal: stop }); } catch { break; }
  }
  if (signal?.aborted) return fail('cancelled_locally', 'LOCAL_INTERRUPT', '仅停止本机等待，Hub 中的工作没有取消。', 130, identity);
  if (last && failures === 0) throw new CliError({ ...last, code: 'WAIT_TIMEOUT', nextAction: '等待到期；可用同一个会话 ID 和回合号继续查。' }, 5);
  return unknown(identity, '等待期间未取得最新可信状态；稍后用同一会话和回合查询。');
}

async function execute(argv: string[], io: IO, setToken: (token: string) => void): Promise<Result> {
  const { cmd, flags, positional } = parse(argv);
  const get = (key: string) => flags.get(key);
  const interactive = io.input.isTTY === true && io.out.isTTY === true && !flags.has('json');
  const profile = get('profile') ?? 'default';
  const profileOpts = { directory: io.profileDir, allowHttp: flags.has('allow-http'), fetch: io.fetch };
  if (cmd === 'auth login') {
    if (io.env.AHUB_API_TOKEN !== undefined || io.env.AHUB_HUB_URL !== undefined) usage('环境令牌模式不落盘；先退出环境模式，再登录保存 profile。');
    const hubUrl = parseHubBase(get('hub') ?? '', profileOpts.allowHttp).href.replace(/\/$/, '');
    let token: string;
    try { token = (flags.has('token-stdin') ? await stdin(io.input, 4096, '令牌') : await readHiddenToken('输入令牌（隐藏）：', { input: io.input, output: io.err })).trim(); }
    catch (err) { if (err instanceof CliError) throw err; return usage('录入令牌需要 TTY，非交互请用 --token-stdin。'); }
    setToken(token);
    await writeProfile(profile, { hubUrl, token }, profileOpts);
    return { status: 'authenticated', hub: hubUrl, profile };
  }
  if (cmd === 'auth logout') {
    await removeProfile(profile, profileOpts);
    return { status: 'logged_out', profile, nextAction: '只清除了本地 profile；要撤销令牌，请到 Hub 外部接入设置。' };
  }
  const envMode = io.env.AHUB_API_TOKEN !== undefined || io.env.AHUB_HUB_URL !== undefined;
  if (envMode && flags.has('profile')) usage('环境令牌不能与 --profile 混用。');
  const conn = resolveConnection(io.env, envMode ? undefined : await readProfile(profile, profileOpts), profileOpts);
  setToken(conn.token);
  const client = createHubClient(conn, profileOpts);
  const request = (path: string) => client.request(path, { signal: io.signal });
  const me = async () => readMe(await request('/me'));
  const store = () => checkpointStore({ directory: io.stateDir });
  const principal = (identity: Awaited<ReturnType<typeof me>>) => `${identity.userId}:${identity.tokenId}`;

  async function write(kind: CheckpointKind, target: CheckpointTarget, path: string, body: (key: string) => Row, receipt: (data: Row) => CheckpointReceipt, identity: Awaited<ReturnType<typeof me>>) {
    const operationId = randomUUID();
    const checkpoints = store();
    const payload = body(operationId);
    const fields = { operationId, ...target };
    try { await checkpoints.begin({ hubUrl: conn.hubUrl, principal: principal(identity), operationId, kind, target, request: payload }); }
    catch { return fail('error', 'CHECKPOINT_WRITE_FAILED', '无法保存本地操作记录；未发送请求。检查本机状态目录。', 2, fields); }
    let result: CheckpointReceipt;
    try {
      result = receipt(row(await client.request(path, { method: 'POST', headers: { 'Idempotency-Key': operationId }, body: payload, signal: io.signal })));
    } catch (err) {
      // Only explicit authentication rejection is known not to reach a use case. Other failures
      // can occur after persistence or during dispatch; neither a status code nor a retry key proves otherwise.
      if (err instanceof HubClientError && err.kind === 'http' && err.status === 401) {
        await checkpoints.record(operationId, { state: 'rejected', receipt: { code: 'HTTP_401' } }).catch(() => {});
        throw new CliError({ ...mapError(err).result, ...fields }, 3);
      }
      await checkpoints.record(operationId, { state: 'unknown', receipt: { code: err instanceof HubClientError && err.status ? `HTTP_${err.status}` : 'UNKNOWN' } }).catch(() => {});
      return unknown(fields, 'Hub 未返回可确认的写入回执；用 operation status 查询本地记录，不要重发。');
    }
    try { await checkpoints.record(operationId, { state: 'accepted', receipt: result }); }
    catch { return unknown({ ...fields, ...result }, '已收到 Hub 回执，但本地记录未能更新；请保存这些 ID 并查询，不要重发。'); }
    return { ...fields, ...result };
  }

  const id = (key: string) => userId(get(key), `--${key} ID`);
  const optionalId = (key: string) => get(key) === undefined ? undefined : id(key);
  const positionalId = () => userId(positional[0], '资源 ID');
  const projects = async () => list(await request('/projects')).map((entry) => choice(entry, 'id', 'name'));
  switch (cmd) {
    case 'auth status': {
      const identity = await me();
      return { status: 'authenticated', hub: conn.hubUrl, userId: identity.userId, userName: identity.userName, tokenId: identity.tokenId, tokenName: identity.tokenName, capabilities: [...identity.caps] };
    }
    case 'project list': return { status: 'ok', projects: list(await request('/projects')).map((p) => select(p, ['id', 'name'])) };
    case 'task list': return { status: 'ok', tasks: list(await request(`/tasks?projectId=${pathId(id('project'))}`)).map((t) => select(t, ['id', 'title', 'status'])) };
    case 'task show': {
      const taskId = positionalId();
      const t = row(await request(`/tasks/${pathId(taskId)}`));
      const pulls = (await request(`/tasks/${pathId(taskId)}/pull-requests`).then((v) => ({ status: 'ok', pullRequests: list(row(v).pullRequests).map((p) => select(p, ['url', 'state', 'status', 'title', 'number', 'repoId'])) }), () => ({ status: 'unavailable' })));
      return { status: 'ok', task: select(t, ['id', 'projectId', 'title', 'status']), sessions: list(t.sessions).map((s) => select(s, ['id', 'title', 'status', 'agentId', 'workerId', 'workspaceId'])), pulls };
    }
    case 'session show': return { status: 'ok', session: select(row(await request(`/sessions/${pathId(positionalId())}`)), ['id', 'taskId', 'title', 'status', 'turn', 'lastSeq', 'agentId', 'model', 'workerId', 'workspaceId']) };
    case 'doctor': {
      const taskId = id('task');
      const workerId = get('worker') === undefined ? undefined : id('worker');
      const agentId = get('agent') === undefined ? undefined : id('agent');
      const identity = await me();
      need(identity.caps, 'session_targets_v1');
      const t = row(await request(`/tasks/${pathId(taskId)}/session-targets`));
      if (t.taskId !== taskId) return protocol();
      const workers = list(t.workers).filter((w) => !workerId || w.workerId === workerId).map((w) => ({
        ...select(w, ['workerId', 'label', 'availability']), blockers: Array.isArray(w.blockers) ? w.blockers.map(str) : [],
        workspaces: list(w.workspaces).map((d) => ({ ...select(d, ['workspaceId', 'label', 'availability']), blockers: Array.isArray(d.blockers) ? d.blockers.map(str) : [] }))
      }));
      const eligible = new Set(workers.map((w) => w.workerId));
      const inventory = list(await request('/workers')).filter((w) => eligible.has(w.workerId)).map((w) => ({
        workerId: w.workerId, agents: Array.isArray(w.agentModels) ? list(w.agentModels).filter((a) => !agentId || a.agentId === agentId).map((a) => ({ ...select(a, ['agentId', 'defaultModel']), models: Array.isArray(a.models) ? a.models.map(str) : [], readiness: a.readiness && typeof a.readiness === 'object' ? select(row(a.readiness), ['state', 'status']) : null })) : []
      }));
      return { status: 'ok', taskId, workers, inventory, nextAction: workers.length ? '选择已登记目录和 Agent 的完整 ID；服务器会在启动时再检查。' : '没有匹配的可见机器；检查项目范围和 Worker 权限。' };
    }
    case 'task create': {
      const title = get('title')?.trim();
      if (!title || title.length > 200) return usage('任务标题须为 1–200 字符。');
      const projectId = interactive && !get('project') ? await withPicker(io, conn.token, async (picker) => {
        const project = await picker.choose('项目', await projects());
        await picker.confirm(`创建任务「${title.replace(/[\p{Cc}\p{Cf}]/gu, ' ')}」`, [project]);
        return project.id;
      }) : id('project');
      return { status: 'created', ...await write('task.create', { projectId }, '/tasks', () => ({ projectId, title }), (r) => {
        if (r.projectId !== projectId) return protocol();
        return { taskId: serverId(r.id) };
      }, await me()) };
    }
    case 'session start': {
      const suppliedModel = get('model');
      if (suppliedModel !== undefined && (suppliedModel.trim() !== suppliedModel || suppliedModel.length > 200)) return usage('模型 ID 无效。');
      const chooseTargets = interactive && ['task', 'worker', 'workspace', 'agent'].some((key) => get(key) === undefined);
      const explicit = chooseTargets ? null : { target: { taskId: id('task'), workerId: id('worker'), workspaceId: id('workspace') }, agentId: id('agent'), model: suppliedModel };
      const identity = await me();
      need(identity.caps, 'bounded_session_start_v1');
      const { target, agentId, model } = explicit ?? await withPicker(io, conn.token, async (picker) => {
        need(identity.caps, 'session_targets_v1');
        const taskId = optionalId('task');
        let project: Choice, task: Choice;
        if (taskId) {
          const entry = row(await request(`/tasks/${pathId(taskId)}`));
          if (entry.id !== taskId) return protocol();
          const projectId = serverId(entry.projectId);
          project = (await projects()).find((item) => item.id === projectId) ?? { id: projectId, label: '项目' };
          task = choice(entry, 'id', 'title');
        } else {
          project = await picker.choose('项目', await projects());
          const tasks = list(await request(`/tasks?projectId=${pathId(project.id)}`));
          task = await picker.choose('任务', tasks.filter((item) => item.projectId === project.id).map((item) => choice(item, 'id', 'title')));
        }
        const targets = row(await request(`/tasks/${pathId(task.id)}/session-targets`));
        if (targets.taskId !== task.id) return protocol();
        const workers = list(targets.workers);
        const worker = await picker.choose('机器', workers.map((item) => ({
          ...choice(item, 'workerId', 'label'), blocked: item.availability !== 'ready' || !list(item.workspaces).some((d) => d.availability === 'ready')
        })), optionalId('worker'));
        const dirs = list(workers.find((item) => item.workerId === worker.id)?.workspaces);
        const workspace = await picker.choose('工作目录', dirs.map((item) => ({ ...choice(item, 'workspaceId', 'label'), blocked: item.availability !== 'ready' })), optionalId('workspace'));
        const inventory = list(await request('/workers')).find((item) => item.workerId === worker.id);
        const agents = Array.isArray(inventory?.agentModels) ? list(inventory.agentModels) : [];
        const agent = await picker.choose('Agent', agents.map((entry) => ({
          ...choice(entry, 'agentId', 'agentId'), blocked: row(entry.readiness ?? {}).state !== 'ready'
        })), optionalId('agent'));
        const models = list(agents.filter((entry) => entry.agentId === agent.id)).flatMap((entry) => Array.isArray(entry.models) ? entry.models : []);
        const selected = await picker.choose('模型', [...new Set(models.map(str))].filter((value) => value && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value)).map((value) => ({ id: value, label: value })), suppliedModel);
        await picker.confirm('启动会话', [project, task, worker, workspace, agent, selected]);
        return { target: { taskId: task.id, workerId: worker.id, workspaceId: workspace.id }, agentId: agent.id, model: selected.id };
      });
      const ack = await write('session.start', target, '/sessions', () => ({ ...target, agentId, ...(model ? { model } : {}), placement: 'bounded_v1' }), (r) => {
        if (r.taskId !== target.taskId || r.workerId !== target.workerId || r.workspaceId !== target.workspaceId || r.agentId !== agentId || (model !== undefined && r.model !== model)) return protocol();
        return { sessionId: serverId(r.id) };
      }, identity);
      return { status: 'registered', ...ack, nextAction: '会话已登记；用 session show 检查就绪状态。' };
    }
    case 'session send': {
      const sessionId = positionalId(), doWait = flags.has('wait');
      if (!flags.has('stdin') || (flags.has('timeout') && !doWait)) return usage('send 需要 --stdin；--timeout 只用于 --wait。');
      const timeout = numeric(get('timeout') ?? '120', 1, 3600, '--timeout');
      const identity = await me();
      if (doWait) need(identity.caps, 'exact_turn_status_v1');
      const text = await stdin(io.input, 64 * 1024, '消息');
      if (!text.trim()) return usage('消息不能为空。');
      const accepted = await write('session.send', { sessionId }, `/sessions/${pathId(sessionId)}/prompt`, (clientMessageId) => ({ text, clientMessageId }), (r) => {
        if (r.ok !== true || !['queued', 'sending'].includes(String(r.state))) return protocol();
        return { sessionId, turn: integer(r.turn, 1), seq: integer(r.seq, 1), ...(r.deliveryId === null ? {} : { deliveryId: serverId(r.deliveryId) }) };
      }, identity);
      if (!doWait) return { ...accepted, status: 'accepted', nextAction: 'Hub 已收件，不代表已送达或完成。' };
      if (!accepted.deliveryId) return unknown(accepted, 'Hub 已收件，但没有可核对的 delivery ID；不要重发。');
      if (!flags.has('json')) io.err.write(`Hub 已收件：操作 ${accepted.operationId}，回合 ${accepted.turn}。\n`);
      return waitTurn(client, sessionId, accepted.turn!, timeout, io.signal, accepted, accepted.operationId);
    }
    case 'session wait': {
      const sessionId = positionalId(), turn = numeric(get('turn'), 1, Number.MAX_SAFE_INTEGER, '--turn');
      const timeout = numeric(get('timeout') ?? '120', 1, 3600, '--timeout');
      need((await me()).caps, 'exact_turn_status_v1');
      return waitTurn(client, sessionId, turn, timeout, io.signal);
    }
    case 'operation status': {
      const operationId = positionalId();
      const checkpoint = await store().get(operationId);
      if (!checkpoint) return fail('error', 'OPERATION_NOT_FOUND', '此机器没有该操作记录；这不是未执行的证据。', 2, { operationId });
      if (checkpoint.hubUrl !== conn.hubUrl || checkpoint.principal !== principal(await me())) return fail('error', 'OPERATION_SCOPE_MISMATCH', '请使用创建操作的 Hub 和令牌。', 3, { operationId });
      const fields = { operationId, kind: checkpoint.kind, ...checkpoint.target, ...checkpoint.receipt };
      if (checkpoint.state === 'unknown' || checkpoint.state === 'pending') return unknown(fields, '只有本地意图，没有确认的 Hub 回执。不要补发；查任务或会话。');
      if (checkpoint.state === 'rejected') return fail('rejected', checkpoint.receipt?.code ?? 'REJECTED', '该请求未被接收。先检查权限或配置。', 3, fields);
      return { ...fields, status: 'accepted', nextAction: '这是本地保存的回执，不代表会话已就绪或回合已完成。' };
    }
    default: return usage('不支持该命令。');
  }
}

export async function runAhub(argv: string[], io: IO): Promise<number> {
  const json = argv.includes('--json');
  if (argv.length === 0 || argv.length === 1 && ['-h', '--help', 'help'].includes(argv[0]!)) {
    io.out.write(`${HELP}\n`);
    return 0;
  }
  let token = io.env.AHUB_API_TOKEN;
  let result: Result;
  let exit = 0;
  try { result = await execute(argv, io, (value) => { token = value; }); }
  catch (error) {
    const mapped = mapError(error);
    result = mapped.result;
    exit = mapped.exit;
  }
  const serialized = redactSecrets(JSON.stringify({ schemaVersion: 1, ...result }, null, json ? undefined : 2), token);
  // Format as JSON even in human mode for nested resources; string controls stay escaped in terminal output.
  (json || exit === 0 ? io.out : io.err).write(`${serialized}\n`);
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancel = new AbortController();
  const onInterrupt = () => cancel.abort();
  process.once('SIGINT', onInterrupt);
  try { process.exitCode = await runAhub(process.argv.slice(2), { env: process.env, input: process.stdin, out: process.stdout, err: process.stderr, signal: cancel.signal }); }
  finally { process.off('SIGINT', onInterrupt); }
}
