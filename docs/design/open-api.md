# 设计：统一开放 API（OpenAPI v1）

- 状态：**proposed**（仅设计，未实现；待 David 拍板 §8）
- 相关：ADR 0011（团队与 RBAC）、#107（操作人记录）、ADR 0013（模型提供商）、ADR 0014（本设计）

## 1. 目标
把平台能力（项目管理、任务、智能体对话、机器）用一份**有版本、有文档、有权限范围**的 HTTP API 开放出来，内部 agent、外部 agent、自动化脚本都用同一套接入。UI 仍可用现有 `/api/*`，开放 API 是它的稳定子集。

## 2. 现状盘点（origin/master，共 105 条 HTTP 路由 + 1 条 SSE + worker WebSocket）
认证：httpOnly cookie 登录态 + CSRF 双提交；旧 `HUB_TOKEN` Bearer 过渡期放行（无身份）；`/api/stream` 唯一允许 `?token=`。权限：`packages/domain/src/access.ts` 的 `can()`，权限点见下表“权限”列。请求体 zod schema 已集中在 `packages/contract/src/wire/http.ts`，这是生成 spec 的基础。

标注：**开放** = v1 候选；**后续** = v1.x 再考虑；**内部** = 不开放（UI 专用 / 管理 / worker 协议 / 账号安全）。

### 2.1 项目（11 + 工作区 5 + 文件 2）
| 方法 路径 | 用途 | 权限 | 标注 |
|---|---|---|---|
| GET /api/projects | 列出可见项目 | project.read | 开放 |
| POST /api/projects | 新建项目 | project.create | 开放 |
| PUT /api/projects/:id/repo | 设置仓库 | project.update | 开放 |
| PUT /api/projects/:id/description | 改描述 | project.update | 开放 |
| DELETE /api/projects/:id | 软删到回收站 | project.delete | 开放 |
| GET /api/projects-trash | 回收站 | project.read | 后续 |
| POST /api/projects/:id/restore | 恢复 | project.restore | 后续 |
| POST /api/projects/:id/purge | 彻底删除 | project.purge | 内部（不可逆，只留 UI） |
| GET /api/projects/:id/files | 项目文件列表 | project.read | 后续 |
| GET /api/projects/:id/canvas | 画布数据 | project.read | 内部（UI 形状） |
| PUT /api/projects/:id/layout | 画布布局 | project.update | 内部 |
| GET/POST /api/projects/:id/workspaces | 工作区列表/新建 | project.read/update | 后续 |
| GET /api/workspaces/:id/changes | 工作区改动 | project.read | 开放（CI 看 diff） |
| POST /api/workspaces/:id/remove、/api/workspaces/sweep | 清理 | project.update | 内部 |
| GET/POST /api/fs/directories | 浏览/建 worker 目录 | worker.use | 内部 |

### 2.2 任务（6）
| POST /api/tasks | 建任务（并开首个会话） | task.write + session.create | 开放 |
|---|---|---|---|
| GET/POST /api/tasks/:id/log、PATCH …/log/:entryId | 工作日志读/写/改 | task.read/write | 开放 |
| PATCH /api/tasks/:id/summary | 摘要 | task.write | 开放 |
| PATCH /api/tasks/:id/status | 状态流转 | task.write | 开放 |

缺口：没有 `GET /api/tasks`、`GET /api/tasks/:id`、`GET /api/sessions/:id` 这类资源读接口（UI 走 canvas/home 聚合）。v1 需补。

### 2.3 会话与对话（10）
| 方法 路径 | 用途 | 权限 | 标注 |
|---|---|---|---|
| POST /api/sessions/:id/prompt | 发消息（文本+base64 附件），记录发送人 | session.control | 开放（核心） |
| GET /api/sessions/:id/events | 历史事件 | session.read | 开放 |
| GET /api/stream（SSE，`event: frame`） | 全部可见会话的实时帧，前端按 sessionId 分流 | session.read（逐帧过滤） | 开放，但 v1 新增按会话过滤的 `GET /sessions/:id/stream` |
| POST /api/sessions/:id/interrupt | 停止 | session.control | 开放 |
| POST /api/sessions/:id/options | 改模型/思考强度 | session.control | 开放 |
| POST /api/sessions/fork | 从最新点分叉 | session.create | 开放 |
| POST /api/sessions/derive | 派生会话 | session.create | 开放 |
| POST /api/sessions/:id/continue | 换机器继续 | session.create | 后续 |
| GET /api/sessions/:id/activity | 操作记录（#107） | session.read | 开放 |
| GET /api/sessions/:id/attachment | 附件缩略图 | session.read | 后续 |

### 2.4 机器与运行时（3 + 接入 4）
| GET /api/workers | 机器列表（含运行时/模型） | worker.read | 开放（只读） |
|---|---|---|---|
| POST /api/workers/:id/probe | 重新探测 | worker.manage | 后续 |
| POST /api/workers/:id/runtimes/:agentId | 安装运行时 | runtime.install | 后续 |
| POST /api/workers/pairing、DELETE /api/workers/:id、GET /api/workers/enroll-info、GET /install-worker.sh | 接入/移除 | worker.enroll/manage | 内部 |
| WS /worker | worker 协议（`packages/contract` RPC） | worker 凭据 | 内部（永不开放） |

### 2.5 模型提供商（8）
GET /api/providers、GET /api/providers/models（开放只读）；POST/PUT/DELETE /api/providers、PUT …/:id/key、PUT …/routing/:workerId、POST …/:id/test（内部：涉及密钥）。

### 2.6 团队成员邀请（6）与审计
GET /api/team（后续只读）；POST/DELETE /api/team/invites、PUT/DELETE /api/team/members/:id…（内部）；GET /api/team/audit（后续，audit.read）。

### 2.7 账号认证（16）、管理后台（14）、资产（18）、其他（3）
`/api/auth/*`（登录、注册、改密、会话管理）全部内部；`/api/admin/*`（用户、worker 更新、设置、审计）全部内部；资产 `/api/admin/assets/*` 17 条内部，`GET /api/sessions/:id/assets` 后续；`/api/health` 开放（无鉴权）、`/api/home`/`/api/search` 内部（UI 聚合）。

### 2.8 汇总
| 分组 | 路由数 | v1 开放 | 后续 | 内部 |
|---|---|---|---|---|
| 项目/工作区/文件 | 18 | 6 | 5 | 7 |
| 任务 | 6 | 6 | 0 | 0 |
| 会话与对话 | 10 | 8 | 2 | 0 |
| 机器/运行时/接入 | 7 | 1 | 2 | 4 |
| 模型提供商 | 8 | 2 | 0 | 6 |
| 团队与审计 | 6 | 0 | 2 | 4 |
| 认证 | 16 | 0 | 0 | 16 |
| 管理后台 | 14 | 0 | 0 | 14 |
| 资产 | 18 | 0 | 1 | 17 |
| 其他（health/home/search） | 3 | 1 | 0 | 2 |
| **合计** | **106** | **24** | **12** | **70** |

## 3. v1 范围（按场景）
- **A 外部 agent 驱动对话**：建任务/会话 → prompt → 订阅单会话 SSE → interrupt / options / fork / derive → 读 events、activity。
- **B 内部 agent 管项目与任务**：项目 CRUD（软删）、任务新建/状态/摘要/工作日志、读工作区改动。
- **C 自动化 / CI**：A+B 的子集 + `GET /workers` 选机器 + `GET /health`；典型流程“建任务→等完成→读 diff→改状态”。

前缀 **`/openapi/v1`**（与 UI 的 `/api/*` 分开，互不牵制；同一批 use case）。新增补齐的读接口：`GET /tasks`、`GET /tasks/:id`、`GET /sessions/:id`、`GET /sessions/:id/stream`。

稳定性规则：v1 内只加不删（新增可选字段、新端点、新事件类型）；删改走 v2 并至少并行 90 天；响应带 `Deprecation`/`Sunset` 头；未知事件类型客户端必须忽略；错误统一 `{ error: { code, message } }`（沿用 domain 错误码）；列表统一游标分页 `?cursor=&limit=`；写操作支持 `Idempotency-Key`（尤其 prompt、建任务）。

## 4. Spec 生成
- 选 **`@hono/zod-openapi`**（Hono 官方中间件，路由即 spec，zod 已在用）。`/openapi/v1` 路由用 `createRoute` 定义，请求/响应 schema 从 `packages/contract/src/wire/http.ts` 复用并 `.openapi()` 命名。
- 产出 `GET /openapi/v1/openapi.json`，文档页 `GET /openapi/v1/docs` 用 **Scalar**（`@scalar/hono-api-reference`，移动端好看）。
- 一致性：(1) CI 生成 spec 并与仓库内 `docs/openapi/v1.json` 快照 diff，非新增变更即失败；(2) 契约测试：e2e 里按 spec 校验真实响应（`openapi-response-validator` 或 zod 解析）；(3) 用 `openapi-typescript` 生成 TS 客户端类型，自用一遍。
- 现有 `/api/*` 不强制迁移；后续可逐步改为 `createRoute` 以复用文档（内部标签，不出现在公开 spec）。

## 5. Agent 鉴权
- 新聚合 **ApiToken**：`{ id, teamId, kind: personal|service, ownerUserId?, name, scopes[], projectIds?, expiresAt, lastUsedAt, revokedAt }`，只存 hash（argon2/sha256+pepper），前缀 `ahp_` 便于泄露扫描，明文只在创建时显示一次。
- **个人令牌（PAT）**：代表某个用户，有效权限 = 用户角色权限 ∩ 令牌 scopes。
- **服务账号**：团队级虚拟成员（role=member 或自定义角色），由 owner/admin 建，离职不受影响；可限定项目。
- **scope → RBAC**：scope 是权限点的打包，`can()` 不变，只在 principal 上叠一层交集：
  - `projects:read` → project.read、task.read；`projects:write` → + project.create/update/delete、task.write
  - `sessions:read` → session.read；`sessions:write` → + session.create、session.control
  - `workers:read` → worker.read、provider.read
  - `worker.use_local` 永远不能授给令牌（保持 David 独占规则）。
- 生命周期：默认 90 天到期、可设不过期（需 owner）、随时吊销；用户被删/禁用时其 PAT 立即失效；UI 显示最近使用时间与 IP。
- 审计：principal 带 `via: {tokenId, name}`，#107 的 author/actor 记录为“David（via CI 令牌）”；令牌创建/吊销写审计。
- 限流：按令牌令牌桶（默认 60 req/min，prompt 10/min，SSE 并发 5），返回 `429` + `Retry-After`；先内存实现（单 hub）。
- 传输：`Authorization: Bearer`；SSE 同样用头（不支持 `?token=`，外部客户端可用 fetch-SSE）；令牌请求免 CSRF。

## 6. 流式与 agent 接入
- **SSE 事件 schema**：`GET /openapi/v1/sessions/:id/stream`，事件类型 `message.delta`、`message.completed`、`tool.call`、`tool.result`、`status`（running/waiting/completed/failed，复用 live-core `waitingForReply` 语义）、`error`、`heartbeat`；每条带单调 `id`，支持 `Last-Event-ID` 断点续传（从事件库补发）。schema 写进 spec（OpenAPI 3.1 无原生 SSE，用 `text/event-stream` + 每种事件的 schema 组件 + 文档说明）。内部 frame 到公开事件做一层映射，内部帧改动不影响外部。
- **Webhooks（后续）**：任务状态变更、会话完成，HMAC 签名、重试；v1 不做。
- **MCP server（推荐 Phase 3）**：`/mcp`（Streamable HTTP），工具 = 开放 API 的薄封装（list_projects、create_task、prompt_session、get_session_events、set_task_status…），同一令牌鉴权、同一 scope。让 Pi/OpenCode/Grok 或外部 agent 直接把平台当工具用；可从 spec 半自动生成工具定义。

## 7. 六边形落位与分期
- **domain**：不变，继续是 use case + `can()`；新增 `ApiToken` 聚合、`ApiTokenRepository` 端口、scope 交集逻辑（纯函数）。
- **contract**：公开 DTO 与事件 schema（zod），与内部 wire 分开文件 `wire/public-v1.ts`。
- **storage-sqlite**：`api_tokens` 表 + 迁移。
- **apps/server**：新的驱动适配器 `openapi-v1.ts`（`OpenAPIHono`），只做 DTO↔use case 映射；鉴权中间件识别 `ahp_` 令牌生成 principal。
- **MCP**：另一个驱动适配器，调用同一批 use case。

分期：
1. **P1 基础**：ApiToken（PAT）+ 设置页管理 + scope 交集 + 审计 via；`@hono/zod-openapi` + Scalar；对话场景 A 全部端点 + 单会话 SSE；spec 快照与契约测试。
2. **P2 项目/任务**：场景 B/C、补齐读接口、分页、幂等、限流；服务账号。
3. **P3**：MCP server；webhooks；视需要开放运行时安装、回收站、团队只读。

## 8. 风险
- 公开 API 冻结后改 domain 变难 → 公开 DTO 与内部 wire 分离，映射层隔离。
- 令牌泄露 → 只存 hash、前缀扫描、短默认期限、最小 scope、`worker.use_local` 禁授。
- 外部 agent 通过 prompt 间接执行任意命令（agent 本身就能跑命令）→ 令牌受项目/worker 限制，服务账号默认不可用本地 worker，审计可追溯。
- SSE 长连接资源 → 并发上限 + 心跳超时。
- 维护两套前缀 → 共享 use case，只多一层薄适配。

## 9. 待拍板（推荐默认加粗）
1. **前缀**：**`/openapi/v1`（与 UI 分开）** / `/api/v1`（UI 也迁过去）。
2. **令牌类型 v1**：**个人令牌先做，服务账号放 P2** / 两者同时做 / 只做服务账号。
3. **spec 库**：**`@hono/zod-openapi` + Scalar** / `hono-openapi`（标准 schema，更灵活）+ Swagger UI。
4. **v1 范围**：**对话 + 项目/任务（24 个端点）** / 只做对话 / 再加机器管理与运行时安装。
5. **MCP server**：**P3 做，复用同一令牌** / 和 P1 一起做 / 不做。
6. **令牌默认有效期**：**90 天，可续** / 30 天 / 永不过期。
