# Agent Hub 交接文档

> 生成时间：2026-11-12  
> 用途：在另一个会话中继续当前工作，先读本文，再读文末列出的设计文档。

## 1. 当前状态

| 项 | 值 |
|---|---|
| 仓库 | `/home/qdw/Projects/workspace/agent-hub` |
| 分支 | `master` |
| 本地 HEAD | `2c2d49c test(e2e): 多仓库项目全链路，修文件用例的手机入口与截图目录` |
| origin/master | 已同步到 `2c2d49c` |
| 阿里云 app | `/root/ahub-server/app`，HEAD `2c2d49c`（2026-11-14 11:36 用 `deploy-aliyun.sh --bundle` 部署，快照 `hub-20261114-113618-pre-c60df95.db`） |
| 阿里云 health | `{"ok":true}` |
| 阿里云 Worker | `local-074cfa87`、`remote-7ecd5a47` 均 online；本地 worker 已升到 `c60df95`（组合工作空间需要它） |
| 本地工作区 | 干净（本轮改动已提交并部署） |
| 最近完整验证 | `npm test` 1376 单测：1368 pass / 8 skipped / 0 fail；`check`、`typecheck`、`typecheck:web`、`build`、`test:e2e-node` 6/6 全 0；`e2e/multi-repo` 1/1、`worktree` 4/4、`settle` 2/2、`files` 1/1 |

当前部署已经包含：侧边栏、移动端 header 收口、对比度/触控优化、会话环境刷新、发送乐观反馈、工具授权跨轮次、会话连线可辨识性与离线限制、会话终端（含手机按键条与刷新回放）、会话删除、会话「收起」、worktree 档位与准备命令、多仓库项目与组合工作空间（M1）。

### 组合工作空间（多仓库）怎么用

1. 项目设置 →「仓库」填 2–8 个（第一个是主仓库）。
2. 会话里「新建会话」→ 工作空间选「新建组合工作空间」，会按项目配置在目标机器上建容器、逐个仓库建 worktree 并跑准备命令。
3. 会话跑起来后，文件页默认是容器目录（只列成员）；改动/提交要先在顶栏选仓库。组合会话不支持回滚（各自提交）。
4. 清理按整组走：工作空间页不允许单删成员。

2026-11-12 夜补丁（已部署 `88ceb7a`）：供应商模型可一键从上游拉取、逐模型配置上下文/最大输出与「额外参数 JSON」（中继顶层浅合并，`hub` 与 `direct` 两条链路都生效），改动对已建立会话走 `provider_update` 热更新；会话里的「连接 N」芯片改为先弹小窗预览再跳转；文件 tab 标出工作空间根路径与完整相对路径（手机端原先看不到路径）。

2026-11-12/13 第二轮（已部署 `41112cc`）：机器页面的 agent 运行时改为「机器自带 + hub 安装」并存，可按机器显式切换（`packages/node-gateway/src/runtime-store.ts` 的调度垫片 `<runtimes>/bin/<command>` → `dispatch.mjs`；卸载保留垫片，缺省回落机器自带）；侧栏新增全站导航分组（工作/我的/团队/管理），账号菜单只留守账号项；会话「⋯」按「这次会话/代码/Agent 配置」分层，手机端补「详情与显示」组，项目设置拆成 项目/上下文/资产/工作空间 四页，运营后台并入「平台设置」并去掉独立 tab；用户可见文案统一把 Worker 叫作「机器」。运行时的版本切换只对**新建**会话生效，正在跑的会话继续用旧版本；供应商的「额外参数」走 `provider_update`，已建立会话即时生效。

2026-11-12 晚补丁（已部署，详见 `docs/plan/known-issues.md` §1.1）：下线 `HUB_TOKEN` 登录通道（`?token=`、`Bearer`、`/api/auth/token-login`、前端 token 登录）；worker 通道改为「有 `HUB_TOKEN` 时比对共享令牌，没有时只认本机子进程」；修掉测试进程泄漏/临时目录污染（`apps/server/src/test-support/spawn.ts`）；`HUB_PORT` 端到端贯通；`deploy-aliyun.sh --bundle` 支持离线更新；门禁补 `check-lockfile`、`check-selftest` 与「解析失败不跳过」。部署后 `POST /api/auth/token-login` 返回 404、`/api/stream?token=` 返回 401，两台 worker 均 online。

2026-11-13 凌晨（已部署 `558179b`，设计稿 `docs/design/terminal.md`）：会话新增「终端」页签，PTY 跑在会话所在机器的工作目录里。浏览器经 `WS /api/sessions/:id/terminal` 接 hub（握手独立做 Host → Origin → 双 cookie → `session.read`），hub 经 `/worker` 通道用 4 个 RPC（`terminal.open/resize/close/list`）+ 3 条单向帧（`terminal_input` / `terminal_data` / `terminal_exit`）转发；不新增 worker 能力（沿用 `sessions` + `session.read`），cwd 由 worker 从会话工作空间表取并过 `WorkerFiles.check`；同一会话只允许一个窗口（第二个直接拒绝）、空闲 30 分钟后回收、hub 重启靠 `terminal.list` 对账、会话结束/删除/机器离线由 hub 发 `terminal.close`。前端用 `@xterm/xterm` + `addon-fit`，切页签不卸载、0 尺寸跳过 fit。依赖 `node-pty` 在 Node 26 上用包内预编译产物，本机与阿里云都已实测可 `spawn('/bin/bash')`。

2026-11-13 上午（`d364086` + `407d9ec`）：终端补移动端。粗指针设备（`(pointer: coarse)`）在终端底部显示一条按键条 `Esc / Tab / Ctrl / ↑ ↓ ← → / Ctrl+C`——手机软键盘没有这些键，vim / opencode 这类全屏 TUI 否则没法用。按键走 `term.input()` 复用现有输入管线（含断线缓存），不另开 socket；粘滞 Ctrl 只作用于方向键（`\x1b[1;5A/B/C/D`），一次性修饰；`onPointerDown` 只 `preventDefault()`，拖动滚动不会误发 Esc；软键盘弹出时 `visualViewport.resize` 补一次 fit。顺带修掉移动端高度溢出：`focus.tsx` 根容器改 `flex min-h-0 flex-1 flex-col`、`app.tsx` 内容列加 `min-h-0`，否则手机上终端的底部（含按键条）会落到可视区外。e2e `e2e/terminal-mobile.spec.ts` 覆盖 390×844（按键条不越界、点 Esc/Ctrl+C 不断线）、390×500（键盘高度）与「窄屏但鼠标语义不显示按键条」；`e2e/files-tabs.spec.ts` 的手机分支改成从「更多」菜单开详情。

2026-11-13 上午（`2962810`）：终端对**已结束的会话**开放。原来页签要求 `session.status === 'running'`，而生产库里 39 条会话全是 `done`，等于没人看得到入口。现在 `terminal.open` 多一个可选 `cwd`：hub 侧 `terminalTarget`（`session.read` + `locationOf` 的项目/工作空间回退）算好目录随 RPC 下发，worker 仍过 `WorkerFiles.check`；不传时仍回落到 `workspaces` 映射（兼容老 hub）。前端页签条件改为「机器在线且未被探测为不支持」，跑完的会话在终端上方多一行 `terminal-notice`：只开 shell，不会重启 agent。`docs/design/terminal.md` §0/§4/§7 已同步。

2026-11-13 上午（`0a4c3b7` + `57df14a`）：会话支持**彻底删除**——「⋯ → 删除会话…」二次确认，服务端在同一个事务里清掉会话行与所有按 `session_id` 关联的数据（journal、产物、连线、检查点、工具授权、消息投递等），Task、项目与工作空间里的文件保留；跑着的会话 409「会话还在跑，先停止再删除」。新增 `session.delete` 权限（owner/admin 全队、member 限自己的会话、viewer 无），审计记 `session.delete`。另修 Android Chrome 键盘弹起时输入栏被顶出屏幕：不再依赖 `100dvh`，改为 `apps/web/src/app-viewport.ts` 把 `visualViewport` 的可见高度/上移量写进 `--app-height` / `--app-offset`，`html, body` 不再可滚、唯一滚动容器是消息列表；同时修 `use-stick-to-bottom.ts` 在容器变矮时误判「用户往上翻」而弹回顶部。iOS Safari 上的键盘动画与惯性仍需真机确认。

2026-11-13 下午（`646fd85` → `1adf3c0`）：思考强度归位与前端分层。`provider-proxy` 的 `mergeModelExtra` 遇到 `reasoning_effort/reasoning/thinking/thinking_config` 时，若 agent 已经发了值就以 agent 为准（配置只当默认值）；模型选择器按提供商收口（hub 模型会话只列同提供商，跨类收进不可点说明）；文件页的「刷新中…」改成不占位的圆角指示器。前端按 `atoms / shell / surfaces` 三层拆分（`apps/web/src/atoms` 55 个、`shell` 58 个、`surfaces/workbench` 36 个、`surfaces/im` 3 个），`FILE_RULES` 加三条反向依赖规则并进 selftest；IM/运行态 DTO 上提到 `packages/contract/src/messaging.ts`；产品形态用 `surfaces/<形态>/manifest.ts` 声明导航与路由，壳只在 `route.ts` 的 `SURFACES` 注册表加一行。设计与后续能力路线见 `docs/design/front-end-layering.md`（§7.1 进展、§10 bot 凭据/options/触发器/资源 API）。

2026-11-13 傍晚（未推送）：C2 bot 启动选项。`PersistentAgent.options` 是建会话时的 seed，四处派生（P2P / 群聊 / 连接器 / 调度器，`apps/server/src/main.ts:262,279,342,375`）都会带上；fork / rewind / continue-elsewhere 现在把 `source.options` 快照进新会话，重启后 `ensureHosted` 不会再丢。bot 页加了「启动选项」编辑区（键建议 `effort`/`thinking`/`mode`——必须是 agent 上报的 configId，`thought_level` 是分类名填不得）。启动侧：ACP 先落模型、未知键告警后跳过，已知键的非法值仍让本次启动失败；Pi 之前根本不应用非 model 选项（等于静默丢弃），现在逐项 `change_option`。

2026-11-13 傍晚（`fb0f46e` + `768ef14`，已部署）：bot 的两块能力。C2 见上一段。C1 给 bot 独立凭据：`ApiToken` 加 `kind:'bot'`（`ahb_` 前缀、`bot:{projectId,name}`），不新开接口面，仍走 `/api` 与 `/openapi/v1`；`decide()` 第 2b 步把权限收窄成「`BOT_PERMISSIONS` 之内 + 资源归属必须是自己的项目」（reason `bot_scope`），只问能力的检查只查上限。新增 scope `groups:write` / `files:read` / `memory:read` / `memory:write`；签发、可见、吊销按项目 owner·admin；同一 bot 重新生成即轮换（旧凭据立刻失效）；`botName` 必须在项目里存在。审计与来历写「以 bot「name」身份」。前端在 bot 编辑页加了「凭据」区（前缀 / 创建时间 / 最近使用 / 生成 / 吊销，明文只显示一次）。注意开放 API 本来就不许用 hub 同机机器，bot 同样，所以 bot 要跑只能落在远端 worker。

## 2. 已完成的主线

### 2.1 Agent Runtime / Paseo 借鉴

参见 `docs/plan/agent-runtime-roadmap.md`。

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 | 完成 | 能力矩阵；`subagent` 三态；缺省能力按 denied |
| P1 | 完成 | Agent Profile CRUD、owner 隔离、派生套用、管理页 |
| P2 | 完成 | Runtime controls、模型元数据、别名搜索、不可选模型 |
| P3 | 完成 | 会话内子代理时间线、画布 badge、失败自动展开 |
| P4 | 完成 | shell/read/search/fetch/subagent/plan 等结构化工具卡 |
| P5 | 部分完成 | 运行时状态可见；`ACP_AGENTS` 别名；无管理 UI/热加载 |
| P6 | 完成 | ACP runtime codec；编排工具 `agent.spawn` 等 |

关键实现：

- `packages/adapters/acp/src/codec.ts`
- `packages/adapters/acp/src/codecs/opencode.ts`
- `packages/domain/src/event.ts`
- `packages/domain/src/use-cases/hosting.ts`
- `packages/domain/src/tools/agent-orchestration-tools.ts`
- `packages/storage-sqlite/src/agent-profiles.ts`
- `packages/storage-sqlite/src/tool-grants.ts`

### 2.2 运行时命令与子代理

- ACP `available_commands_update` 已映射成 `commands` 事件，输入 `/` 能看到运行时命令。
- 旧会话通过 `session/load` 回放时保留命令表。
- OpenCode 子代理走 `opencode/session/child_update` **extNotification**，不是 `session/update`；已在 ACP runtime 注册并声明 client `_meta['opencode/child-session-updates']`。
- 子代理事件不新增 Hub 会话、不增加画布节点。

### 2.3 可靠性

- 工具授权不再按单轮结束回收；TTL 7 天、最长 30 天。
- 工具授权失效时 `ensureHosted` 会自动重新托管，签发新 token。
- 会话环境 revision：
  - `Session.environmentRevision`
  - `SessionEnvironmentPort.revision()`
  - 资产/MCP 环境变化时下一轮自动重托管
  - 设计见 `docs/design/session-environment-refresh.md`

### 2.4 UI / 交互

- 响应式项目侧边栏：桌面常驻 256px，手机抽屉。
- 移动端会话 header 只留返回、标题、状态、更多；连接/显示设置/详情收进更多。
- 模型与思考强度控件相邻。
- 会话页显示当前 git 分支、改动数、ahead。
- 排队消息固定在输入框上方。
- 发送消息立即出现乐观气泡，失败恢复输入。
- 对比度、触控目标、焦点环、`prefers-contrast` 增强。
- 会话连线弹层显示任务/机器/工作空间/短 id；离线机器禁止新建连接。
- 斜杠命令菜单命令名不裁切。

### 2.5 部署

- 阿里云服务：`agent-hub-server`，端口 17900，数据 `/root/ahub-server/data`。
- 最近备份：`/root/ahub-server/backups/hub-20261112-1245-pre-bb7f732.db`。
- 远程 Worker 代码：`/home/qdw/agent-hub`，当前 `2d9f305`（Worker 侧适配器改动已经包含；之后提交主要是 server/web）。
- 公网 SSH `8.213.197.187:22` 目前不稳定/会被拒绝；Tailscale `100.110.66.47:22` 可用。
- 临时部署 env：`/tmp/opencode/aliyun-tailscale.env`，使用：
  ```bash
  ALIYUN_ENV_FILE=/tmp/opencode/aliyun-tailscale.env scripts/aliyun-ssh.sh '...'
  ```
- 凭据在 `.env.deploy.local`（gitignored），不要把任何密码/token 写进文档或提交。

## 3. 阿里云部署步骤

GitHub 推送已经恢复，但阿里云仍无法直接访问 GitHub，部署走 bundle。

```bash
cd /home/qdw/Projects/workspace/agent-hub

# 1) 本地 bundle（注意从旧 HEAD 开始）
git bundle create /tmp/opencode/hub-<sha>.bundle <old-sha>..HEAD
sha256sum /tmp/opencode/hub-<sha>.bundle

# 2) 上传
ALIYUN_ENV_FILE=/tmp/opencode/aliyun-tailscale.env \
  scripts/aliyun-ssh.sh 'cat > /root/hub-<sha>.bundle' \
  < /tmp/opencode/hub-<sha>.bundle

# 3) 远端备份 + ff
ALIYUN_ENV_FILE=/tmp/opencode/aliyun-tailscale.env scripts/aliyun-ssh.sh '
  set -e
  cd /root/ahub-server/app
  cp /root/ahub-server/data/hub.db /root/ahub-server/backups/hub-$(date +%Y%m%d-%H%M)-pre-<sha>.db
  git bundle verify /root/hub-<sha>.bundle
  git fetch /root/hub-<sha>.bundle HEAD:refs/heads/deploy-<sha>
  git merge --ff-only deploy-<sha>
  git rev-parse --short HEAD
'

# 4) 依赖/构建/重启/健康
ALIYUN_ENV_FILE=/tmp/opencode/aliyun-tailscale.env scripts/aliyun-ssh.sh '
  set -e
  cd /root/ahub-server/app
  npm ci --no-audit --no-fund --maxsockets=4
  npm run build
  systemctl restart agent-hub-server
  sleep 2
  systemctl is-active agent-hub-server
  curl -fsS http://127.0.0.1:17900/api/health
'
```

注意：

- bundle 的 ref 是 `HEAD`，不是 `master`，所以远端 fetch 用 `HEAD:refs/heads/deploy-<sha>`。
- 只改 Web 时可以跳过 `npm ci`，但仍建议跑 `npm run build`。
- 部署后检查 `/api/health` 和 `/api/workers`。
- 如果修改了 Worker 代码，还要更新 `/home/qdw/agent-hub`、`npm ci`、`systemctl --user restart agent-hub-worker`。
- Hub 的安装命令内嵌启动时的 commit；改完 HEAD 后要重启 Hub，旧安装脚本不要继续用。

## 4. 验证基线

```bash
npm run check
npm run typecheck
npm run typecheck:web
node --test --test-concurrency=1 \
  "packages/**/*.test.ts" \
  "apps/server/**/*.test.ts" \
  "apps/worker/**/*.test.ts" \
  "apps/web/src/**/*.test.ts"
npm run build
```

最近一次：

- `check`：65 ports，通过
- `typecheck` / `typecheck:web`：通过
- 单测：989 个，986 pass / 3 skipped / 0 fail
- `build`：通过

E2E 使用：

```bash
E2E_PORT=7896 \
E2E_DATA_DIR=/tmp/agent-hub-e2e-data \
E2E_HUB_MODEL=hub-mycodex/go-glm-5.3-flash \
E2E_HUB_PROVIDER_BASE_URL=<cliproxy baseUrl> \
ZAI_CODING_CN_API_KEY=<cliproxy key> \
npx playwright test e2e/canvas.spec.ts --reporter=list
```

最近相关 E2E：`canvas` 8、`chat` 4、`list-view` 1、`session-links` 1，共 14 passed。

## 5. 未完成 / 建议下一步

1. **P5 管理 UI + 热加载**
   - 目前别名仍通过 Worker 的 `ACP_AGENTS` 环境变量配置。
   - 改完需要重连/重启 Worker。
   - 要做管理 UI，需要新增 Worker 命令、持久化文件、运行时重建。

2. **P6b 其他 runtime codec**
   - 目前只有 OpenCode codec。
   - 接 Claude Code / Codex 等私有工具名/通知差异明显的 runtime 时再补。

3. **发送反馈 P1**
   - 已有前端乐观气泡。
   - 设计中的服务端 202 ack + `clientMessageId` 幂等 + 后台投递还没做。
   - 见 `docs/design/message-send-feedback.md`。

4. **环境刷新 P1/P2**
   - 工具目录缓存。
   - Pi shim 动态读取版本化资产、动态增删外部 MCP。
   - `tools.hot_reload` 能力位。
   - 持久 MCP 连接 + `list_changed`。
   - 见 `docs/design/session-environment-refresh.md`。

5. **其他小项**
   - 手动“高对比度”开关（目前跟随 `prefers-contrast: more`）。
   - 右侧详情抽屉（当前详情仍是会话内弹层/区域）。
   - 更多离线/弱网 E2E。

## 6. 关键文档

- `docs/plan/agent-runtime-roadmap.md` — P0–P6 状态与验收
- `docs/design/acp-runtime-codec.md` — ACP runtime codec
- `docs/design/session-environment-refresh.md` — 环境 revision + 自动重托管
- `docs/design/message-send-feedback.md` — 发送反馈 P0/P1
- `docs/adr/0034-subagent-display.md` — 子代理显示
- `docs/adr/0035-session-commands.md` — 运行时斜杠命令
- `AGENTS.md` — 项目结构、环境、部署约定

## 7. 继续工作时的建议顺序

1. 先跑第 4 节验证基线，确认当前 HEAD 可复现。
2. 若要继续 Paseo 方向：先做 P5 管理 UI/热加载，或补第二个 runtime codec。
3. 若要继续体验优化：做发送反馈 P1 或环境刷新 P1。
4. 每完成一项：提交 → 推送 GitHub → bundle 部署阿里云 → health/Worker 检查 → 更新本交接文档。

2026-11-14 凌晨（`f56489f`，已部署；本地 worker 在 `bf4114c`）：CAP-1 运行时别名。机器页可以给某台 Worker 声明 ACP 运行时别名（`GET/PUT /api/workers/:id/agents`，owner 写、owner/admin 读），保存即推 `agent_config` 帧热应用——worker 重建 harness、就地替换 runtimes 与就绪探测、原子写 `$WORKER_STATE_DIR/agents.json`，重建失败保持旧值，成功后主动重报 agent 清单。别名是声明、不带 env（密钥仍在本机）。语义：填了别名就只按别名提供 ACP agent，OpenCode 这类内置 ACP agent 会被替换，Pi / Grok 是独立适配器不受影响；留空回到 `ACP_AGENTS`。热应用要重建模型清单，约 20 秒才在日志里收尾。

2026-11-14 早（`54ec357`，已部署；本地 worker 同版本）：worktree 机制 W1+W2，设计见 `docs/design/worktree.md`。项目可配「默认共用长期空间 / 每个任务开隔离 worktree」与准备命令（`command` / `waitForSetup` / `timeoutSeconds`，默认 600 秒、30..1800）；`POST /api/sessions/derive` 的 `workspaceMode` 在没给 `workspaceId` 时现建空间并同步跑准备命令，`workspaceId` 显式优先；平台建的临时空间才有 `setup` 状态（`none/running/ready/failed` + 退出码 + 输出尾 8KB），失败目录保留、`POST /api/workspaces/:id/setup/retry` 重跑，`waitForSetup` 时 `failed/running` 拒绝派发。程序只走 `/bin/sh -lc`，env 用允许列表并强制剔除 `HUB_TOKEN`/`HUB_WORKER_CREDENTIAL`/`HUB_LOCAL_SECRET`/`HUB_URL`/`HUB_PARENT_PID`，超时按进程组 SIGTERM→3s→SIGKILL（`exitCode 124`），输出抹 `user:token@`。界面：项目设置「工作空间」页配档位与命令（非 owner·admin 只读），derive 对话框一行复选框（选了临时空间时禁用），会话页页签行下显示准备中/失败重试/准备日志。T3 Code 的调研与可借鉴清单在同目录 `docs/design/interaction-borrowing.md`（I1 列表状态 + settle 尚未做）。


2026-11-14 上午（`a518b96`，已部署）：会话**收起**（I1，借自 T3 Code 的 settle，改名避免与记忆混淆）。做法是给 `Session` 加 `settledAt`——只表示「移出活跃列表」，不改状态、不杀进程、不删数据；`POST /api/sessions/:id/settle {settled}`，权限 `session.settle`（默认 own），跑着的会话 409「会话还在跑，先停止再收起」，写审计 `session.settle`。前端：会话菜单「收起：移出活跃列表 / 移回活跃列表」，侧栏拆成活跃与底部「已收起 N」，画布卡片补状态点与「已跑 N 分钟」（只在 working 时 30 秒推进）、已收起的卡片与首页最近会话都弱化到背景。自动收起（PR 合并 / 陈旧）等有稳定的「最后活动时间」口径再做。设计与后续 I2–I4（composer 手势、三档 diff、侧聊）见 `docs/design/interaction-borrowing.md`，worktree 机制见 `docs/design/worktree.md`（W1+W2 已上线，W3/W4 未做）。
