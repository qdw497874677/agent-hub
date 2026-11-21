// sessions 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import { projectEvents } from '../projection.ts';
import {
  changeOptionRequest,
  deriveSessionRequest,
  forkSessionRequest,
  promptAckSchema,
  promptRequest,
  sessionSchema,
  settleSessionRequest,
  setSessionModelRequest
} from '@agent-hub/contract';
import { V1, json, body, errors, okSchema, route } from './base.ts';
import {
  agentMessageSchema,
  peerSchema,
  sessionLinkSchema,
  sendMessageRequest,
  acceptedSchema,
  waitSec,
  sessionId,
  sessionWithHandleSchema,
  sessionGitRunRequest,
  sessionGitStateSchema,
  sessionGitRunResultSchema,
  workspaceDiffSchema,
  workspaceFileSchema,
  eventListSchema,
  settleSessionResponse
} from './schemas.ts';

export const sessions = {
  startSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions`, tags: ['sessions'], summary: '在任务下开一条会话',
    description:
      '在任务下开一条会话，派到指定机器（workerId）上跑。本机（hub 同机）的机器开放 API 永远用不了，必须给一台已登记的远程 Worker。\n' +
      '参数：taskId、agentId、model（省略或空串=按 resolve_default_agent 的层级取：任务默认 > 项目默认 > 团队运行时默认模型）、workerId（建议显式给在线机器）、workspaceId（可选）、groupId（可选：已有的组合工作空间；多仓项目要先在 Hub 建组，本工具不会自动建组合组）、assetIds（可选：只带这些资产）。\n' +
      '会话通信：repoId（可选：一仓一会话——只为项目里这个仓库新开隔离 worktree，和 workspaceId / groupId 互斥）、handle（可选：任务内短名，别的会话用 peer:<handle> 找它）、linkWith（可选：建好后和这些同项目会话连线，连上才能互发消息）。\n' +
      '资产：不传 assetIds = 用项目生效的全部资产；要排除某个技能/指令时，传完整清单减掉它（清单里的 id 必须对该项目可见，看不见的会被丢掉）。\n' +
      '返回：会话对象（id、status、model、workspaceId、handle）。handle 是任务内短名，和 session_peers 返回的一致：没显式传 handle 时用默认短名 `<agentId>-<会话 id 的 4 位后缀>`；只有没接消息总线时为 null。\n' +
      '下一步：用 session_reply 发第一句；用 events 或 list_task_log 跟进展。\n' +
      '错误：400 参数不合法（含 handle 格式、repoId 不在项目里）；403 无 sessions:write 或不能和 linkWith 里的会话说话；404 linkWith 的会话不在同一项目；409 机器不可用、没装该 runtime、短名已被占用或 linkWith 的会话已收起（archived）。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试不会开第二条会话。',
    request: body(deriveSessionRequest),
    responses: { 201: json(sessionWithHandleSchema, '已开始') }
  }, { module: 'sessions', need: 'session.create', readOnly: false, expose: 'session_start', idempotent: true }),
  forkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/fork`, tags: ['sessions'], summary: '从某条消息分叉',
    request: body(forkSessionRequest),
    responses: { 201: json(sessionSchema, '已分叉') }
  }, { module: 'sessions', need: 'session.create', readOnly: false, expose: 'fork_session', idempotent: true }),
  getSession: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}`, tags: ['sessions'], summary: '会话详情',
    description:
      '取一条会话的状态与配置。**status 只描述最近一轮**：running = 这一轮在跑；done/stopped/interrupted/failed = 这一轮的结果。\n' +
      '参数：sessionId。\n' +
      '返回：会话对象（status、turn、lastSeq、model、workspaceId、taskId…；taskId 可能为 null，表示常驻容器会话）。handle 是任务内短名，和 session_peers 返回的一致：没显式设 handle 时是默认短名 `<agentId>-<会话 id 的 4 位后缀>`；只有没接消息总线时为 null。\n' +
      '轮询用法：记下 turn；调 events(sessionId, sinceTurn=turn) 或 events(sessionId, after=lastSeq)；未到终态就 3–5 秒后再看；看到本 turn 的 ended 事件即这一轮结束。\n' +
      '下一步：用 events 读它的时间线；要发下一句用 session_reply。\n' +
      '长轮询：waitSec（0–50）= 这一轮还在跑时最多等这么久再返回（不取消这一轮；到点仍在跑就原样返回 running）。\n' +
      '错误：404 会话不存在或属于看不见的项目。',
    request: { params: sessionId, query: z.object({ waitSec }) },
    responses: { 200: json(sessionWithHandleSchema) }
  }),
  setSessionModel: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/model`, tags: ['sessions'], summary: '换这条会话的模型（可换提供商）',
    description:
      '把会话切到另一个模型；目标模型在另一个提供商下时，服务端会停掉旧进程、按新配置重启，并用 resume 接回历史。\n' +
      '参数：sessionId（路径）、model（模型 id；hub 提供商的模型写成 hub-<标识>/<模型>，用 list_models 看有哪些——hub 托管模型排在前面；list_workers 的 agentModels 也会带上这些 hub 模型）。\n' +
      '返回：更新后的会话对象。\n' +
      '副作用：正在跑的回合会中断；历史保留。\n' +
      '错误：400 模型不在可选清单里；403 没有 session.prompt 权限或那个提供商用不了；404 会话不存在；409 会话已结束或无法重启。',
    request: { params: sessionId, ...body(setSessionModelRequest) },
    responses: { 200: json(sessionSchema), ...errors }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_model', idempotent: true }),
  prompt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/prompt`, tags: ['sessions'], summary: '对会话说话',
    description:
      '给会话发一条消息，立即返回（202）；回合在后台跑。\n' +
      '参数：text、clientMessageId（建议总是带；同一条消息重试用同一个值，服务端按它去重）。\n' +
      'MCP 重试：clientRequestId 是整个工具调用的重试键（同一值不会重复发送）；clientMessageId 是这条消息的去重键，两者独立——换 clientRequestId 重试同一条消息时，仍靠 clientMessageId 去重。\n' +
      '返回：{ ok, turn, seq, deliveryId, state }——turn 是这句开启的轮次。\n' +
      '轮询用法：拿返回的 turn，反复调 events(sessionId, sinceTurn=turn)；读到的每条事件都带同一个 turn；看到 ended 就是这一轮结束（事件里 outcome 区分 done/stopped/interrupted/failed）。\n' +
      '下一步：轮询 events 或 list_task_log 看进展与结论；要打断用 session_cancel。\n' +
      '错误：404 会话不存在或看不见；409 会话不在运行（先 session_start）；429 太频繁。',
    request: { params: sessionId, ...body(promptRequest) },
    responses: { 202: json(promptAckSchema, '已接收（回合在后台跑）') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_reply', idempotent: true }),
  interrupt: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/interrupt`, tags: ['sessions'], summary: '打断正在跑的会话',
    description:
      '打断当前回合（相当于人点「停止」），会话本身保留，之后还能继续发消息。\n' +
      '参数：sessionId。\n' +
      '返回：{ ok: true }。\n' +
      '下一步：要放弃任务用任务状态接口；要重跑直接 session_reply。\n' +
      '错误：404 会话不存在或看不见。',
    request: { params: sessionId },
    responses: { 200: json(okSchema) }
  }, { module: 'sessions', need: 'session.interrupt', readOnly: false, expose: 'session_cancel' }),
  changeOption: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/options`, tags: ['sessions'], summary: '改可调项（模型、思考强度…）',
    request: { params: sessionId, ...body(changeOptionRequest) },
    responses: { 200: json(sessionSchema) }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'change_option', idempotent: true }),
  events: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/events`, tags: ['sessions'], summary: '会话事件（after 之后的）',
    description:
      '读会话时间线（对外已投影）：只有文本、工具名与成败、结束原因、诊断占位。\n' +
      '参数：sessionId；after（只取 seq > after 的事件）；sinceTurn（只取第几轮及之后的事件，配合 session_reply 返回的 turn 用）；waitSec（0–50，没有*可投影且符合过滤条件*的事件时最多等这么久，有就立刻返回）。\n' +
      '返回：`{ events: [{ seq, at, turn, event }], nextAfter }`。MCP 的 structuredContent 就是这份对象（不要把数组再包进 result）。event.kind ∈ text | tool | tool_result | ended | diagnostic。\n' +
      'nextAfter 是本窗扫到的最后一条原始 journal seq（thinking / prompt 等被投影丢掉时也要前进），没有原始事件时沿用入参 after 或 0。下次把 after 设为 nextAfter，不要因为 events 为空就重复拉同一段。\n' +
      '轮询用法：第一次 sinceTurn=turn、after 可省略；之后用 after=返回的 nextAfter 增量拉；本 turn 出现 ended 即结束。有 waitSec 时这一次调用会阻塞到有可投影的匹配事件或超时，不必自己短间隔空转。\n' +
      'waitSec 与 sinceTurn / after 一起用时：只在还没有可投影且符合过滤条件的事件时才等待（会话启动留下的 prompt / thinking / 无 turn 旧事件不会让它立刻空返回，也不会把 nextAfter 卡在 0）。\n' +
      '下一步：把 after 设为 nextAfter 继续轮；工具细节与思考过程不对开放 API 暴露。\n' +
      '错误：404 会话不存在或看不见。',
    request: {
      params: sessionId,
      query: z.object({
        after: z.coerce.number().int().min(0).optional(),
        sinceTurn: z.coerce.number().int().min(0).optional(),
        waitSec
      })
    },
    responses: { 200: json(eventListSchema) }
  }, { module: 'sessions', need: 'session.read', expose: 'events', project: projectEvents }),
  linkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/links`, tags: ['sessions'], summary: '把两条会话连起来（能互发消息、只读看对方工作空间）',
    description:
      '连两条同项目的会话（无向、幂等）。连上后两边的 agent 能用 agent.ask / agent.send 互发消息（to 写 peer:<短名>），能用 workspace.read 的 session 参数只读看对方文件。\n' +
      '参数：sessionId；body `{ otherSessionId }`。两条会话你都要能 session.prompt。\n' +
      '返回：连线对象。\n' +
      '下一步：session_peers 看短名；session_message 给其中一条派活。\n' +
      '错误：400 连自己；404 不在同一个项目；409 两边机器都不在线。',
    request: { params: sessionId, ...body(z.object({ otherSessionId: z.string().min(1) })) },
    responses: { 201: json(sessionLinkSchema, '已连上') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_link', idempotent: true }),
  unlinkSession: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/unlink`, tags: ['sessions'], summary: '断开两条会话',
    description:
      '断开连线（重复断开也成功）。断开后双方不能再互发消息（派生父子关系不受影响），已发的消息和审计保留。\n' +
      '参数：sessionId；body `{ otherSessionId }`。\n' +
      '返回：{ ok: true }。\n' +
      '错误：400 断自己；403 / 404。',
    request: { params: sessionId, ...body(z.object({ otherSessionId: z.string().min(1) })) },
    responses: { 200: json(okSchema) }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_unlink' }),
  sessionPeers: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/peers`, tags: ['sessions'], summary: '会话的同伴',
    description:
      '这条会话能直接说话的同伴（显式连线 + 派生父会话）：短名 handle（用 peer:<handle> 寻址）、session id、机器 workerId、仓库、分支、标题、状态（idle / busy / archived）。\n' +
      '参数：sessionId。\n' +
      '返回：{ peers: [...] }。\n' +
      '下一步：session_link 增加同伴；session_message 给某条会话发消息。',
    request: { params: sessionId },
    responses: { 200: json(z.object({ peers: z.array(peerSchema) })) }
  }, { module: 'sessions', need: 'session.read', expose: 'session_peers' }),
  sessionMessage: route('sessions:write', {
    method: 'post', path: `${V1}/sessions/{sessionId}/messages`, tags: ['sessions'], summary: '以外部 agent 身份给会话发消息（send / ask）',
    description:
      '经消息总线给会话发一条 agent 消息，署名「外部 · <令牌名>」，包在不可信边界里；ask 的回复进你的外部收件箱（不唤醒任何会话）。\n' +
      '和 session_reply 的区别：session_reply 是以令牌主人身份对会话下指令（普通一轮）；session_message 是 agent 消息，受限额和防风暴约束，回复能按 messageId 关联。\n' +
      '参数：sessionId；body `{ kind: send|ask, body, parts?, wake?, timeoutSec? }`。parts 是结构化附件（data / ref / file / link，≤8 个，≤16KB）；wake=false 只进对方收件箱（只有 send）；timeoutSec 30–14400（只有 ask，默认 1800）。\n' +
      '返回：{ messageId, traceId, status, targetSessionId }；status = delivered（对方空闲，已开新一轮）/ queued（对方忙，排队）/ done（wake=false）。\n' +
      '下一步：ask 用 message_get(messageId, waitSec≤50) 等回复，或 message_inbox 增量取；回复的 replyStatus 是 ok / failed / refused。\n' +
      '错误：400 参数不合法；403 没有 session.prompt 或 duplicate（10 分钟内重复）；409 archived（会话已收起）/ rate_limited（同一会话每分钟最多 6 条）；404 会话不存在。\n' +
      '重试：给 clientRequestId，同一值重试不会发第二条。',
    request: { params: sessionId, ...body(sendMessageRequest) },
    responses: { 201: json(acceptedSchema, '已接收') }
  }, { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_message', idempotent: true }),
  getMessage: route('sessions:read', {
    method: 'get', path: `${V1}/messages/{messageId}`, tags: ['sessions'], summary: '外部发的一条消息与它的回复',
    description:
      '查你（这个令牌）发出的一条消息的状态和回复。waitSec（0–50）：还没有回复时最多等这么久（长轮询，到点没回复就照常返回）。\n' +
      '参数：messageId；waitSec。\n' +
      '返回：{ message, reply }；reply 为 null 表示还没回；reply.replyStatus = ok / failed / refused，reply.failure 有值表示超时（timeout）/ 对方已收起（archived）等。\n' +
      '下一步：没回复就再调一次（带 waitSec）；多条在等时用 message_inbox。\n' +
      '错误：404 不是这个令牌发的或不存在。',
    request: { params: z.object({ messageId: z.string().openapi({ param: { name: 'messageId', in: 'path' } }) }), query: z.object({ waitSec }) },
    responses: { 200: json(z.object({ message: agentMessageSchema, reply: agentMessageSchema.nullable() })) }
  }, { module: 'sessions', need: 'session.read', expose: 'message_get' }),
  messageInbox: route('sessions:read', {
    method: 'get', path: `${V1}/inbox`, tags: ['sessions'], summary: '外部收件箱（回复）',
    description:
      '这个令牌收到的回复（含失败通知），按时间正序。收件箱绑令牌：吊销令牌后就打不开了。\n' +
      '参数：after（上一页最后一条的 createdAt，默认 0）；limit（1–100，默认 50）。\n' +
      '返回：{ messages: [...], next }；next = 最后一条的 createdAt，下一次作为 after 传回。\n' +
      '下一步：按 replyTo 关联到你发的 ask。',
    request: { query: z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) },
    responses: { 200: json(z.object({ messages: z.array(agentMessageSchema), next: z.number() })) }
  }, { module: 'sessions', need: 'session.read', expose: 'message_inbox' }),
  stream: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/stream`, tags: ['sessions'], summary: '会话事件流（SSE）',
    description:
      '先补发 `after`（或 `Last-Event-ID`）之后的事件，再实时推。\n\n' +
      '- `event: event`，`id` = 事件序号，`data` = `{ seq, event, at, turn }`（同 /events 的一项）\n' +
      '- `event: status`，`data` = `{ status }`：只有状态变了\n' +
      '- 每 15 秒一条 `: ping` 注释保活。每个令牌最多同时开 5 条。',
    request: { params: sessionId, query: z.object({ after: z.coerce.number().int().min(0).optional() }) },
    responses: { 200: { content: { 'text/event-stream': { schema: z.string() } }, description: 'SSE 流' } }
  }, { skip: 'SSE 不适合做工具调用；长任务用 session_events 轮询或 REST /stream' }),
  activity: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/activity`, tags: ['sessions'], summary: '谁对这条会话做了什么',
    request: { params: sessionId },
    responses: { 200: json(z.array(z.object({ action: z.string(), actor: z.object({ id: z.string(), name: z.string() }), detail: z.string(), at: z.number() }))) }
  }),
} as const;

export const sessionsWork = {
  sessionGitState: route('sessions:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/git/state`, tags: ['sessions'], summary: '按仓看 git 状态和未提交改动',
    description:
      '返回当前分支、未提交文件、ahead、能不能推送/开 PR，以及任务上已关联的 PR。\n' +
      '参数：sessionId；组合会话必须给 member（仓库名、repoId 或 workspaceId）。\n' +
      '错误：400 没选仓库（会列出可选成员）/ 403 无 sessions:read 或 files:read / 404。',
    request: { params: sessionId, query: z.object({ member: z.string().min(1).max(120).optional() }) },
    responses: { 200: json(sessionGitStateSchema) }
  }, { module: 'sessions', need: 'session.read', expose: 'session_git_state' }),
  workspaceDiff: route('files:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/workspace/diff`, tags: ['sessions'], summary: '读工作树的未提交 diff（只读）',
    description:
      '返回该会话工作树相对 HEAD 的 `git diff` 文本与未提交文件清单；未跟踪文件只列名字（如「新文件：notes.md」），内容不进 diff。没有改动时 patch 为空串，不是错误。\n' +
      '参数：sessionId；query.member?（组合会话选成员仓库：仓库名 / repoId / workspaceId）；query.maxBytes?（patch 上限，默认与上限都是 256 KiB，超出截断并标 truncated=true）。\n' +
      '错误：400 不是 git 仓库、或组合工作空间的容器根没选成员 / 403 无 sessions:read / 404。',
    request: { params: sessionId, query: z.object({ member: z.string().min(1).max(120).optional(), maxBytes: z.coerce.number().int().positive().max(256 * 1024).optional() }) },
    responses: { 200: json(workspaceDiffSchema) }
  }, { module: 'sessions', need: 'session.read', expose: 'workspace_diff' }),
  workspaceReadFile: route('files:read', {
    method: 'get', path: `${V1}/sessions/{sessionId}/workspace/file`, tags: ['sessions'], summary: '读工作树里的一个文件（只读）',
    description:
      '读该会话工作树内一个相对路径的文件，返回 UTF-8 文本（binary 时 content 为空串，用 binary 自行判断）。单次上限 256 KiB：超限直接报错，不返回截断内容——先读目录，分块取大文件。\n' +
      '路径必须留在工作树内：绝对路径、含 `..`、`.git` 内部路径都会被拒绝；组合会话的 `.agent-hub` 标记与敏感文件（.env、*.pem、*.key、SSH 私钥等）要 query.confirmed=1 才能读。\n' +
      '参数：sessionId；query.path（必填，工作树内相对路径）；query.member?（组合会话选成员）；query.confirmed?。\n' +
      '错误：400 路径逃逸 / 超上限 / 403 无 sessions:read / 404 文件不存在。',
    request: {
      params: sessionId,
      query: z.object({ path: z.string().min(1).max(4096), member: z.string().min(1).max(120).optional(), confirmed: z.enum(['1', 'true']).optional() })
    },
    responses: { 200: json(workspaceFileSchema) }
  }, { module: 'sessions', need: 'session.read', expose: 'workspace_read_file' }),
  sessionGitRun: route(
    'sessions:write',
    {
      method: 'post', path: `${V1}/sessions/{sessionId}/git/run`, tags: ['sessions'], summary: '按仓提交、推送或开 PR',
      description:
        '在指定成员仓库上执行 git：commit 只提交，push 有改动时先提交再推送，pr 再开 PR 并关联到任务。\n' +
        '参数：sessionId；body.action、message（commit/push 有改动时必填）、title?、body?、member?（组合会话必填，仓库名或 workspaceId）。\n' +
        '返回：sha、committed、pushed、branch、pullRequest（已关联任务）、compareUrl、notes。\n' +
        '权限：提交要 session.prompt；推送/PR 要 git.push（已包含在 sessions:write）。本机 Worker 不可用。\n' +
        '错误：400 没选仓库或默认分支上不能开 PR / 403 / 404 / 409。',
      request: { params: sessionId, ...body(sessionGitRunRequest) },
      responses: { 200: json(sessionGitRunResultSchema) }
    },
    { module: 'sessions', need: 'session.prompt', readOnly: false, expose: 'session_git_run', idempotent: true }
  ),
} as const;

export const sessionsSettle = {
  sessionSettle: route(
    'sessions:write',
    {
      method: 'post', path: `${V1}/sessions/{sessionId}/settle`, tags: ['sessions'], summary: '收起或恢复会话',
      description:
        'settled=true 把会话移出活跃列表（对话保留）；独占且干净的临时 worktree 会立刻拆除，有未提交/未跟踪/未推送改动则留下（kept）并记原因，仍被其它会话占用的会 deferred 留给 workspace_sweep。settled=false 按原分支恢复 worktree。\n' +
        '还在跑的会话要先 session_cancel。PR 合并后也可先调 task_pull_requests?refresh=1，平台会尝试自动收起。\n' +
        '参数：sessionId；body.{ settled: boolean }。返回：会话对象，另带 cleanup.items[]（每条 worktree / 成员仓：removed / kept+reason / deferred+reason）。\n' +
        '下一步：看 cleanup.items；若都是 removed，不必指望 workspace_sweep 再拆一次（它会说明已经在收起时拆除）。错误：403 无 session.settle（sessions:write 已包含）/ 409 还在跑 / 404。',
      request: { params: sessionId, ...body(settleSessionRequest) },
      responses: { 200: json(settleSessionResponse) }
    },
    { module: 'sessions', need: 'session.settle', readOnly: false, expose: 'session_settle', idempotent: true }
  ),
} as const;
