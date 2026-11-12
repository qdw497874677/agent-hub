# Agent Hub 交接文档

> 生成时间：2026-11-12  
> 用途：在另一个会话中继续当前工作，先读本文，再读文末列出的设计文档。

## 1. 当前状态

| 项 | 值 |
|---|---|
| 仓库 | `/home/qdw/Projects/workspace/agent-hub` |
| 分支 | `master` |
| 本地 HEAD | `ff34492 docs: add current state handoff` + 本轮修复（见 §9，尚未推送 origin） |
| origin/master | 已同步到 `ff34492` |
| 阿里云 app | `/root/ahub-server/app`，HEAD `bb7f7325f`（**尚未部署本轮修复**） |
| 阿里云 health | `{"ok":true}` |
| 阿里云 Worker | `local-074cfa87`、`remote-7ecd5a47` 均 online |
| 本地工作区 | 干净（本轮修复已提交） |
| 最近完整验证 | `npm test` 983 单测：975 pass / 8 skipped / 0 fail，26s（默认并发，不含 `e2e/**`）；`npm run test:e2e-node` 6/6；`npm run check`、`typecheck`、`typecheck:web`、`build` 全 0 |

当前部署已经包含：侧边栏、移动端 header 收口、对比度/触控优化、会话环境刷新、发送乐观反馈、工具授权跨轮次、会话连线可辨识性与离线限制。

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
