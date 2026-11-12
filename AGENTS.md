# AGENTS.md

本文件给在这个仓库里工作的 agent（以及人）看。**离得最近的 AGENTS.md 优先**；子目录如果要覆盖规则，自己放一份。

## 1. 这个项目是什么

agent-hub 是运行时无关的 agent 工作台：自带机器和 agent，把任务拆成多个可并行的会话，并把派生 / 分叉的血缘关系持久化下来。

- 领域核心：`Task / Session / Agent / Artifact`，见 `packages/domain`
- 控制面：`apps/server`（HTTP + SSE + SQLite）
- 数据面：`apps/worker`（跑 agent 进程）
- 画布：`apps/web`
- 架构约束：`npm run check`（domain 纯净性、包边界、端口签名、lockfile 一致性）
- 关键文档：`README.md`、`GLOSSARY.md`、`docs/adr/`

## 2. 环境

| 环境 | 用途 | 入口 |
| --- | --- | --- |
| 本地 | 开发、单测、E2E、试新功能 | `http://127.0.0.1:7878` |
| 阿里云 | **实际使用 / 部署验证** | `http://8.213.197.187:17900` |

凭据、主机、路径统一放在 **`.env.deploy.local`**（本地文件，已在 `.gitignore`，绝不提交）。

**本地 Worker 已接入阿里云 hub**（经 Tailscale）：

| 项 | 值 |
| --- | --- |
| Worker ID | `remote-7ecd5a47`（标签 `omarchy`） |
| HUB_URL | `ws://100.110.66.47:17900/worker` |
| 服务 | `agent-hub-worker`（systemd user） |
| 配置 | `~/.config/agent-hub/worker.env` |
| 代码 | `/home/qdw/agent-hub`（已更新到 `origin/master`） |
| 允许目录 | `/home/qdw/Projects/workspace:/home/qdw/agent-hub-test` |

当前阿里云 hub 上有两台在线 Worker：`local-074cfa87`（阿里云本机）和 `remote-7ecd5a47`（本地）。


```bash
# 读配置（不要打印密码）
set -a; . ./.env.deploy.local; set +a
```

### 阿里云拓扑

| 项 | 值 |
| --- | --- |
| SSH | `root@8.213.197.187:22` |
| Tailscale | `100.110.66.47` |
| Hub | `/root/ahub-server/app`，服务 `agent-hub-server`，端口 `17900` |
| Hub 数据 | `/root/ahub-server/data` |
| Hub 环境 | `/root/ahub-server/server.env` |
| Worker | 随 hub 内嵌启动（`local-074cfa87`），没有独立 worker 服务 |
| Node | `/root/.local/node26/bin/node` |

注意：

- 2026-11-09 已清理旧的 `/root/agent-hub`、`agent-hub-worker.service`（连 `127.0.0.1:17878`）和 `/root/.config/agent-hub/worker.env`。
- `HUB_HOST=0.0.0.0`、`HUB_PORT=17900` 是公网可达的；改鉴权相关配置前先确认账号体系与 `HUB_TOKEN` 状态。
- 机器只有 2 vCPU / 1.7 GiB，不要在上面跑重负载并行测试。

## 3. 日常命令

```bash
npm install
npm run check              # 架构约束
npm run typecheck          # 后端 + packages
npm run typecheck:web
npm test                   # 单测（不含 e2e/**，并发跑，约 27 秒）
npm run test:e2e-node      # e2e/**/*.test.ts 的 node:test 用例
npm run test:all           # 上面两个都跑
npm run test:serial        # 串行全量（排查并发问题时用）
npm run build              # 只构建前端
npm run up                 # 构建前端 + 起 server（默认同机起 worker）
npm run dev                # server + Vite
```

跑真 `npm install` / `npm pack` 的用例默认跳过，需要时 `HUB_TEST_INSTALL=1 npm test`。

## 4. 浏览器 E2E

- 配置：`playwright.config.ts`
- 独立端口：`E2E_PORT`（默认 `7896`）
- 独立数据：`E2E_DATA_DIR`（默认 `/tmp/agent-hub-e2e-data`）
- 浏览器：系统 Chromium（`/usr/bin/chromium`）
- 单条冒烟：

```bash
E2E_PORT=7896 E2E_DATA_DIR=/tmp/agent-hub-e2e-data \
  npx playwright test e2e/auth.spec.ts --reporter=list
```

E2E 会真的起 server + worker，部分用例会调真实 agent；Grok 未登录时相关用例会失败或跳过。

### 手动起一个可看的实例

```bash
mkdir -p /tmp/agent-hub-demo
HUB_PORT=7897 HUB_DATA_DIR=/tmp/agent-hub-demo \
HUB_SPAWN_WORKER=1 WORKER_ROOTS=/tmp \
HUB_TEST_ACCOUNT_FILE=/tmp/agent-hub-demo/test-account \
HUB_MAIL_PROVIDER=log HUB_MAIL_OUTBOX=/tmp/agent-hub-demo/outbox.jsonl \
node apps/server/src/main.ts
```

测试账号密码在 `/tmp/agent-hub-demo/test-account`。截图可以用 `playwright` 的无头 Chromium。

## 5. 部署

### 本地

```bash
npm install && npm run build
node apps/server/src/main.ts
```

### 阿里云

先确认本地 `npm run check && npm run typecheck && npm run typecheck:web` 通过，再部署。

```bash
# 只读检查
scripts/aliyun-ssh.sh 'hostname; systemctl is-active agent-hub-server'

# 走仓库自带的备份 → ff-only → npm ci → build → restart → health 流程
scripts/deploy-aliyun.sh
```

**注意：阿里云上解析不了 `github.com`**（实测 `Could not resolve host`），所以 `deploy-hub.sh` 里的 `git fetch origin` 会失败。网络恢复前走 bundle 分支（DEP-1，一条命令，含 sha256 与上传）：

```bash
# 本地打包 → 上传 → 远端：备份 → fetch bundle → ff-only merge → npm ci → build → restart → health
scripts/deploy-aliyun.sh --bundle <服务器当前提交>
```

手工等价流程（脚本不可用时）：

```bash
git bundle create /tmp/opencode/hub-update.bundle <server-head>..master
scripts/aliyun-ssh.sh 'cat > /root/hub-update.bundle' < /tmp/opencode/hub-update.bundle
scripts/aliyun-ssh.sh '
  export PATH=/root/.local/node26/bin:$PATH
  cd /root/ahub-server/app
  scripts/deploy-hub.sh --app /root/ahub-server/app --data-dir /root/ahub-server/data \
    --service agent-hub-server --node /root/.local/node26/bin/node --bundle /root/hub-update.bundle
'
```

失败时回退：`git reset --hard <旧提交>` → `npm ci && npm run build` → `systemctl restart agent-hub-server`。

**`npm ci` 报 `EAI_AGAIN`**：阿里云默认的 `100.100.2.136/138` DNS 曾整体失效，npm 会把 `node_modules` 清空后卡住。先备份 `/etc/resolv.conf`，临时加 `nameserver 223.5.5.5` 再重试；装完可按需恢复。不要用 `pkill -f "npm ci"`，它会匹配并杀掉自己的 SSH 命令，按 PID 杀。

`scripts/deploy-hub.sh` 的约定：

- 部署前快照数据库；快照失败则不部署
- 代码只允许 `--ff-only`；失败自动回退代码并重启
- **不自动恢复数据库**；需要恢复时人工确认
- 健康检查：`http://127.0.0.1:17900/api/health`

部署后至少验证：

1. `/api/health` 200
2. 页面能登录
3. 机器页 Worker 在线
4. 新开一条会话能收到第一条回复

## 6. 已知问题与注意事项

- **`npm test` 卡住的旧症结已修**（2026-11-12，REL-1）：e2e 子进程原本 `stdio: pipe` 且 `stop()` 不等待；现在统一走 `apps/server/src/test-support/spawn.ts`（`stdio: 'ignore'` + SIGTERM→3s→SIGKILL），`npm test` 不再包含 `e2e/**`，默认并发约 27 秒。若再卡住先看这个助手。
- **`package-lock.json` 可能落后**：`npm ci` 会报缺包。现在 `npm run check` 末尾的 `check:lockfile` 会直接失败，`npm install` 后提交锁文件即可。
- **SSH 允许 root 密码登录**且服务端 OpenSSH 较老；长期应改密钥登录并关闭密码认证。
- **截图**：远端截图是文件，SSH 终端看不到；用 `scp` 或 SSH 端口转发到本地浏览器。

## 7. 安全规则

- 不把 `.env.deploy.local`、`server.env`、`worker.env`、密钥、令牌写进仓库、日志或回复。
- 不在回复里打印密码；需要远程命令时用 `scripts/aliyun-ssh.sh`（临时 askpass，退出即删）。
- 涉及数据库删除、迁移回滚、生产重启的操作，先说明影响再执行。
- 不把 hub 改成 `0.0.0.0` 裸奔；公网必须同时有账号体系或 `HUB_TOKEN`。
- 不碰用户真实数据目录：`~/.local/share/agent-hub`、`/root/ahub-server/data`；测试用 `/tmp` 独立目录。
