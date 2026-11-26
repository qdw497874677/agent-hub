# 测试与验收

本页是 [AGENTS.md](../../AGENTS.md) 的测试入口。部署命令和生产安全规则仍在 AGENTS.md；具体的隔离配置见 [E2E 隔离指南](isolated-e2e.md)，本机依赖和真实 Agent 配置见 [E2E 本机环境](e2e-local-env.md)。

## 日常命令

```bash
npm run check              # 架构、包边界、端口签名、lockfile
npm run typecheck          # 后端 + packages
npm run typecheck:web      # 前端
npm test                   # 并行单测，不含 e2e/**
npm run test:e2e-node      # e2e/**/*.test.ts 的 node:test 集成用例
npm run test:all           # 单测 + node:test 集成，不含 Playwright
npm run test:serial        # 串行单测，排查并发问题
npm run ci                 # check + 两套类型检查 + npm test
```

真正执行 `npm install` 或 `npm pack` 的测试默认跳过；有需要时运行 `HUB_TEST_INSTALL=1 npm test`。

- `npm test` 卡住：先检查 `apps/server/src/test-support/spawn.ts` 和测试清理是否等待子进程退出。旧问题是遗留的 pipe 句柄和 `stop()` 未等待；共享助手把输出直接写入日志文件，先发 SIGTERM，3 秒后仍未退出则发 SIGKILL。
- `npm ci` 报锁文件缺项：用 `npm run check:lockfile` 确认；锁文件确实落后时用 `npm install` 同步 `package-lock.json`，并和依赖改动一起提交。

## Web 提交门禁

**只要改了 `apps/web/**`，提交前必须跑相关 Playwright，纯文案也不例外。** 单测和构建不能代替浏览器验证。

- 改到某条流程，跑对应的 `e2e/<area>.spec.ts`。新增交互、布局或移动端改动（<640px）要补断言，新增 testid 应在用例中使用。改文案要有用例覆盖相关文案。提交信息或报告写明命令和结果。
- 修改 Web 展示或交互时同时检查桌面与移动端；共享流程分别用桌面、移动视口跑 Playwright。能力、状态含义、操作后果与反馈要一致，优先复用判断和交互逻辑。布局可以不同，但不能丢关键操作或把必要说明只放在悬停里。确需只改一端时，在报告里说明另一端为何无需改动。
- 异步状态按证据展示：加载中不等于不存在；Hub 已入队、运行时已就绪、已交给运行时、回合已结束是不同阶段。就绪不等于模型已回复；没收到回执不等于未送达，结果未知不能盲目重送。除成功路径外，至少验证一个与改动相关的延迟、断连或回执缺失场景。

## 浏览器 E2E 与手动冒烟

配置在 `playwright.config.ts`，默认用系统 Chromium（`/usr/bin/chromium`）。每轮用独立端口和全新的数据目录，不默认复用 `7896` 或 `/tmp/agent-hub-e2e-data`。单条冒烟示例（先确认端口空闲）：

```bash
E2E_PORT=7896 E2E_DATA_DIR="$(mktemp -d /tmp/agent-hub-e2e.XXXXXX)" \
  npx playwright test e2e/auth.spec.ts --reporter=list
```

- **每轮新库不等于每个用例新库。** 依赖全局计数或空状态的用例（例如首页待办总数），要单独用新库运行，或只断言本用例拥有的数据。单跑通过、合跑失败时，先核对前序用例留下的状态，不要放宽断言来掩盖串扰。复用旧库还可能因同名 bot 撞到 `bots.team_id, name`，导致服务启动失败。
- 普通 Web 流程优先用真实 Hub/Worker 加确定性的假 ACP，显式选择并断言测试 Worker。真实模型另测，不借用本机登录或默认模型；未配置真实运行时或模型凭据导致的跳过，不算业务验证通过。
- 并行构建使用独立检出，避免覆盖彼此的 `dist`。遇到配额、SQLite WAL I/O 或 Chromium 启动失败，先查临时目录可写性、容量和套接字路径长度；不要用生产数据目录或生产 Worker 来绕过。

手动查看页面时，先运行 `npm run build`，然后用新目录和空闲端口起一套本地实例。下面用 `env -i` 启动，不继承生产变量或本机 Agent 的 HOME：

```bash
demo=$(mktemp -d /tmp/agent-hub-demo.XXXXXX)
mkdir -p "$demo/home"
env -i PATH="$PATH" HOME="$demo/home" HUB_PORT=7897 HUB_DATA_DIR="$demo" \
HUB_SPAWN_WORKER=1 WORKER_ROOTS="$demo" WORKER_STATE_DIR="$demo/worker" \
WORKER_ASSETS_DIR="$demo/worker-assets" HUB_TEST_ACCOUNT_FILE="$demo/test-account" \
HUB_MAIL_PROVIDER=log HUB_MAIL_OUTBOX="$demo/outbox.jsonl" \
node apps/server/src/main.ts
```

测试账号文件在 `$demo/test-account`，截图可用无头 Chromium。不要加载生产环境文件；完整环境隔离见 [E2E 隔离指南](isolated-e2e.md#怎样才不会碰到现有服务)。

## 发布验收与检验记录

1. **发布前**：在干净目录用最终待发布的 Git 树运行 `npm ci`、`npm run ci` 和适用的 Playwright。合入新基线或选择性暂存后，不能沿用不匹配的工作树测试结果。确认已提交的树与通过验收的树相同，再推送、部署。
2. **部署后**：核对远端 `HEAD` 与已验证且已推送的 SHA 一致、备份完整性通过、公网和适用的 Tailnet 入口首页及 `/api/health` 返回 200。Web 发布还要核对线上主 JS 与验收构建的哈希。这些只证明部署和基础可用性。
3. **业务冒烟另记**：用获准的测试账号登录，在机器页确认目标 Worker 在线，再用测试会话确认能收到首轮回复。未经授权不做生产业务冒烟，须明确记录未做的检查；不能用 200 或 Worker 重连日志代替。

报告写明提交 SHA、测试命令和结果、日志位置，以及未覆盖的检查。

### 记录示例：2026-11-26 手机会话导航

- 发布提交 `8426e0af`，验收树 `d55f59281207eb11ac7dfdf1d52f11e25f27de24`。`npm ci`、`npm run check`、`npm run typecheck`、`npm run typecheck:web` 通过；`npm test` 3660 通过、8 跳过、0 失败。
- Playwright 联跑时，差异评审用例留下 4 条中断会话，首页待办由预期 7 条变为 11 条。换成两套独立测试库后，导航 15 项、快捷打开与差异评审 4 项全部通过，未放宽断言。
- 本机日志：`~/tmp/ah-e2e/ah-nav-release.eaPy6P/`（`unit.log`、`navigation.log`、`coexistence.log`、`deploy.log`）。上线后核对了 SHA、备份、公网与 Tailnet 健康、前端哈希；**未做生产登录或首轮回复验证**。
