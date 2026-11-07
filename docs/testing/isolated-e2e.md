# 隔离环境里跑 CI 和完整 E2E

这份说明只描述仓库里已经有的命令和参数。不读取、不复制生产 `server.env`，不改生产配置，不把生产 Worker 指到测试进程。

对应提交以包里的 `git rev-parse HEAD` 为准。PR #211 的验证包说明见同一次提交。

## 版本

| 项 | 要求 | 出处 |
| --- | --- | --- |
| Node | `>=26` | 根目录 `package.json` 的 `engines` |
| 依赖 | `npm install`（锁定版本用 `npm ci`） | `README.md`；锁文件是 `package-lock.json` |
| 前端构建 | `npm run build` | 只构建 `apps/web`。后端没有构建步骤，直接 `node apps/server/src/main.ts` |
| 浏览器 | 系统 Chrome / Chromium。`E2E_CHROME` 覆盖路径，默认 `/usr/bin/chromium` | `playwright.config.ts`。Playwright 不下载自带浏览器 |
| 完整 E2E 的 agent | PATH 上要有 `pi`（或用例点名的 agent），并且 **这个进程的 HOME** 里 pi 能列出模型 | `README.md` 开发一节；就绪逻辑在 `packages/adapters/pi/src/readiness.ts` |
| pi 安装版本 | 仓库安装器推荐 `1.4.0`（`@earendil-works/pi-coding-agent`） | `packages/adapters/pi/src/installer.ts`。E2E 用 PATH 上的那个 `pi`，不强制这一个版本 |

`npm run ci` 不启动服务，也不需要 pi。`npm run e2e` 会自己构建前端并拉起一套 server + 本机 worker。

## 官方命令

```bash
npm ci
npm run build
npm run ci
npm run e2e
```

手动起一套（不是 E2E，会用默认数据目录和 7878 端口）：

```bash
npm run up    # npm run build && node apps/server/src/main.ts
```

开发热更新是 `npm run dev`。装 systemd 是 `scripts/install.sh`。隔离验证不要跑这两条，也不要跑 `scripts/install-worker.sh`。

## 完整 E2E 实际会动什么

`npm run e2e` 即 `playwright test`（`playwright.config.ts`）。

它**不会**预先删除数据目录。`e2e/global-setup.ts` 只把本次 run id 写到固定文件 `/tmp/agent-hub-e2e-run`。配置注释写明不能在配置里 `rmSync` 数据目录。用例用各自的标题区分，不假设库是空的。要空库，在**还没有**测试进程时自己删掉下面的 `E2E_DATA_DIR`。

它**不会**去连已经开着的服务。`reuseExistingServer` 是 `false`。端口被占用时，`apps/server/src/main.ts` 拒绝启动并提示换 `HUB_PORT`，不会附着到占用者上。

默认端口和目录：

| 变量 | E2E 默认 | 生产默认（不要指到这里） |
| --- | --- | --- |
| 监听 | `E2E_PORT`，默认 **7896**。传给子进程的 `HUB_PORT` | `HUB_PORT` 默认 **7878**，`HUB_HOST` 默认 `127.0.0.1` |
| 数据库 | `E2E_DATA_DIR`，默认 `/tmp/agent-hub-e2e-data`，并设成 `HUB_DATA_DIR` | `~/.local/share/agent-hub` |
| 测试账号密码文件 | `$E2E_DATA_DIR/test-account`（`HUB_TEST_ACCOUNT_FILE`） | `~/.config/agent-hub/test-account` |
| 邮件 | `HUB_MAIL_PROVIDER=log`，信追加到 `$E2E_DATA_DIR/outbox.jsonl` | 看 `SMTP_*` / `RESEND_API_KEY` |
| Worker 可访问目录 | `WORKER_ROOTS=/tmp` | 未设置时是 `$HOME` |
| Worker 资产 | `WORKER_ASSETS_DIR=$E2E_DATA_DIR/worker-assets` | `~/.agent-hub/assets` |
| 模型自检 | `WORKER_MODEL_CHECK=0` | 默认会做自检 |

另外写死、不能用环境变量换的：

- 组件用例的假 npm registry：`127.0.0.1:17981`（`HUB_NPM_REGISTRY`）
- 开 PR 用例的假 GitHub API：`127.0.0.1:17982`（`HUB_GITHUB_API`）
- run id 文件：`/tmp/agent-hub-e2e-run`
- 画布主用例的项目目录：`/tmp/agent-hub-e2e-project-<run id>`
- 不少用例把截图写进**当前检出目录**的 `shots/` 或 `/workspace/shots`。在独立检出里跑，不要在生产部署目录里跑。

`HUB_SPAWN_WORKER=1` 时，server 拉起的本机 worker 的 `HUB_URL` 被设成 `ws://127.0.0.1:<E2E_PORT>/worker`。它只连这套测试 server。

## 怎样才不会碰到现有服务

在生产机器上跑之前，用一套**干净的环境变量**和**独立的家目录**。`playwright.config.ts` 把当前 `process.env` 整份传给测试 server，server 再传给它拉起的 worker。shell 里如果已经有生产用的 `HUB_TOKEN`、`SMTP_PASS`、`RESEND_API_KEY`，会进测试进程。不要 `source` 生产环境文件。

下面这组是最小隔离。把路径换成这台机器上的空目录。`7897` 仅在确认不是现网端口时使用；现网如果占了 7896 或 7878，就再换一个未监听的端口。

```bash
unset HUB_TOKEN HUB_URL HUB_WORKER_CREDENTIAL HUB_SECRET_KEY \
  SMTP_HOST SMTP_URL SMTP_USER SMTP_PASS RESEND_API_KEY HUB_MAIL_FROM \
  PI_DEFAULT_MODEL XAI_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY
export ISOLATED_HOME=/var/tmp/agent-hub-e2e-home
export ISOLATED_DATA=/var/tmp/agent-hub-e2e-data
export E2E_PORT=7897
export E2E_DATA_DIR="$ISOLATED_DATA"
export E2E_CHROME=/usr/bin/chromium
export HOME="$ISOLATED_HOME"
export WORKER_STATE_DIR="$ISOLATED_HOME/.config/agent-hub"
export WORKER_ID="e2e-local"
export PI_COMMAND="$(command -v pi)"
mkdir -p "$ISOLATED_HOME" "$ISOLATED_DATA" "$WORKER_STATE_DIR"
```

必须单独设置 `HOME` 和 `WORKER_STATE_DIR` 的原因：E2E 没有替本机 worker 改这两项。不设的话，worker 会读当前用户的 `~/.config/agent-hub/worker-id`（默认身份文件）和 `~/.pi`（pi 自己的模型配置）。那是在借用这台机器上已经登录过的 pi，也和现网 worker 的身份文件撞在一起。用例里另外注册的远程 worker 自己用临时目录，不走这个默认值。

确认再跑：

- `ss` 或同等命令里，`E2E_PORT`、`17981`、`17982` 都没有被现网占用。
- `HUB_DATA_DIR` 不会是 `~/.local/share/agent-hub`。`npm run e2e` 会把它设成 `E2E_DATA_DIR`。不要另外执行不带 `HUB_DATA_DIR` 的 `npm run up`。
- 检出目录不是现网正在跑的那份代码。
- 不执行 `scripts/install.sh`，不重启现网 systemd 用户服务。

## 已授权模型怎么给这套测试用

代码**不**从 `server.env` 读模型密钥。`readEnv` 只看进程环境变量。pi 的模型列表来自 pi 自己（`pi --mode rpc` 的 `get_available_models`）。一个模型都没有时，就绪原因是「未配置模型」，`POST /api/sessions/derive` 对这个 agent 返回 503。`WORKER_MODEL_CHECK=0` 只跳过启动后的模型自检，不跳过这次就绪判断。

完整 E2E 里，画布主用例（`e2e/canvas.spec.ts`）让模型只回一句 `E2E-OK-<run id>`，120 秒内要出现在会话卡片里。这需要 pi 在**隔离 HOME** 下真能调用一个已授权模型。做法是在这台测试机上为隔离 HOME 单独准备 pi 的配置（隔离 HOME 里的 `~/.pi/agent/models.json`，或只对这个 HOME 做一次 `pi` 的 `/login`）。密钥留在 pi 自己的配置里。不要从生产 `server.env`、生产 `worker.env` 或生产用户的 `~/.pi` 复制。

Hub 的「模型提供商」是另一条路，说明在 `docs/model-providers.md`。空库上的内置测试账号（默认 `test@agent-hub.local`，密码在 `$E2E_DATA_DIR/test-account`）会成为这个库的集群管理员，可以在页面上添加个人、团队或全站提供商。密钥加密后只进这个 `HUB_DATA_DIR` 的库，不改 `~/.pi/agent/models.json`。会话里要选 `hub-<标识>/<模型>` 才会用它。

这条路**不能**单独让 `npm run e2e` 变绿：就绪检查发生在下发提供商之前，画布用例也不去选 `hub-*` 模型。提供商配置适合隔离实例上的手工验证，不能代替 pi 自己的模型目录。

假 ACP（`packages/adapters/acp/test-fixtures/fake-agent.mjs`）只被本来就启动它的用例使用，例如来历、送达、可观测树里的送达节点。不要把它放进默认 worker 的 `ACP_AGENTS` 来冒充整套 E2E 通过。`e2e/chat-real.spec.ts` 只有 `E2E_REAL=1` 才跑，默认跳过。

可观测三条用例不需要模型。在同一套隔离变量下可以先跑：

```bash
npm run e2e -- e2e/observe.spec.ts
```

## 建议的执行顺序

1. 解压源码包到独立目录，`git rev-parse` 不适用（包里没有 `.git`）。对一下包旁的 SHA256 和说明里的提交号。
2. 安装 Node ≥ 26，确认 `E2E_CHROME` 指向本机浏览器，`pi --version` 在将要导出的 `PATH` 上。
3. 按上一节导出隔离变量。不要载入生产环境。
4. `npm ci`，然后 `npm run ci`。这一步不占端口、不写 hub 数据库。
5. 为隔离 HOME 配好已授权的 pi 模型后，再 `npm run e2e`。记录命令、耗时、通过/失败/跳过，以及失败是「未配置模型」还是断言。
6. 跑完可以删掉 `ISOLATED_HOME` 和 `ISOLATED_DATA`。不要删 `~/.local/share/agent-hub` 或 `~/.config/agent-hub`。
