# 已知问题修复计划

> 生成时间：2026-11-12
> 基线：`ff34492`（`master`，工作区干净）；`npm run check` / `typecheck` / `typecheck:web` 通过；单测 983 / 980 pass / 3 skipped（不含 `e2e/**/*.test.ts`，含则为 989）。
> 来源：`AGENTS.md` §6、`docs/handoff/2026-11-12-current-state.md` §5、`docs/plan|design` 未完成项、代码扫描、部署脚本与本地 Worker 状态核查。
> 本文只描述问题、方案与顺序，不代表已排期。

## 0. 分级与原则

| 级别 | 定义 | 节奏 |
|---|---|---|
| P0 | 越权、凭据泄露、生产不可用、数据损坏 | 单独发布，不等其他项 |
| P1 | 用户可见错误、部署/测试反复踩坑、文档失真导致误判 | 本迭代 |
| P2 | 体验打磨、需要真实需求触发的能力 | 有需求再做 |

修复原则：

1. **先修根因再改流程**。`npm test` 卡住不靠「记得加 `--test-concurrency=1`」解决，先把 stdio/信号处理修对。
2. **每个批次可独立发布、可独立回退**。B1 只动鉴权入口，B2 只动脚本与测试，互不阻塞。
3. **不引入新依赖**解决 P1；能用 Node 内置 API 就不加包。
4. 每批完成都跑第 5 节的验证基线，再按 `AGENTS.md` §5 走 bundle 部署。

## 1. 总表

| ID | 问题 | 级别 | 批次 | 改动面 |
|---|---|---|---|---|
| SEC-1a | `?token=` 查询串仍被接受（SSE 路径） | P0 | B1 | server / 测试 |
| SEC-1b | `/api/auth/token-login` 可直接登成第一个 Owner，`Bearer` 遗留 | P0 | B1 | server / web / 启动 guard / 部署 env |
| SEC-2 | 阿里云允许 root 密码登录 SSH | P0 | B1 | 运维（非代码） |
| REL-1 | `npm test` 默认并发卡住（子进程 pipe + 只发 SIGTERM） | P1 | B2 | `e2e/server-env.test.ts`、`apps/server/src/observe-flag.test.ts`、`package.json` |
| REL-2 | `check-import-boundaries.mjs` 静默 `continue`，门禁可假通过 | P1 | B2 | `scripts/` |
| REL-3 | 测试污染仓库根、共享 `/tmp` 目录、随机端口碰撞 | P1 | B2 | 3 个测试文件 |
| REL-4 | `HUB_PORT` 链路断裂：vite 代理与部署脚本写死 7878 | P1 | B2 | `vite.config.ts`、`scripts/` |
| DEP-1 | 阿里云无法访问 GitHub，bundle 部署全靠手工 | P1 | B3 | `scripts/deploy-hub.sh --bundle` + `scripts/deploy-aliyun.sh --bundle` |
| DEP-2 | 本地 Worker 代码落后 Hub 11 个提交（当前无协议错配） | P2 | B3 | 运维 + commit 可见性 |
| DEP-3 | lockfile 一致性无门禁（当前 16/16 一致） | P2 | B3 | 新增 `check:lockfile` |
| DOC-1 | 4 份设计文档状态与代码不符 | P1 | B4 | `docs/` |
| CAP-1 | P5 `ACP_AGENTS` 写入型 UI + 热加载 | P2 | B5 | worker / web |
| CAP-2 | P6b 第二个 runtime codec | P2 | B5 | adapters |
| CAP-3 | 发送反馈 P1（202 ack + `clientMessageId` 幂等） | P2 | B5 | domain / server / web |
| CAP-4 | 环境刷新 P1/P2（目录缓存、shim 动态资产、能力位、持久 MCP） | P2 | B5 | worker / domain |
| CAP-5 | 小项：High contrast 手开关、右侧详情抽屉、离线 E2E | P2 | B5 | web / e2e |

### 1.1 进展（2026-11-12）

已落地并通过验证：SEC-1a、SEC-1b、REL-1、REL-2、REL-3、REL-4、DEP-1、DEP-3、DOC-1。

验证基线（`master` + 本轮改动）：`npm run check` 0（含新 `check:lockfile`：16 workspaces）、`npm run typecheck` / `typecheck:web` 0、`npm test` **984 tests / 976 pass / 8 skipped / 0 fail，26.5s**（默认并发）、`npm run test:e2e-node` 6 / 6、`npm run build` 0。

具体落点：
- SEC-1a：`apps/server/src/auth.ts` 删 `?token=` 与 `SSE_PATH`；`apps/server/src/http.ts:302-310` 只认 `Bearer` 请求头。
- SEC-1b：删 `/api/auth/token-login`、`Bearer` 过渡、`AuthState.tokenLogin`、前端 token 登录模式（`apps/web/src/auth.tsx`、`apps/web/src/api.ts`）；启动守卫移到 `apps/server/src/main.ts:611-621`（非 loopback 时需 `HUB_TOKEN` 或已有 Owner）。
- worker 加固：`packages/node-gateway/src/server-gateway.ts:418-427`，`HUB_TOKEN` 为空时无凭据 worker 不再放行，只认 hub 自己拉起的本机子进程（`localSecret`）；未改协议。
- REL-1/REL-3：新增 `apps/server/src/test-support/spawn.ts`（`stdio:'ignore'` + SIGTERM→3s→SIGKILL + `reservePort()`），`e2e/spawn-hub.ts` re-export；`npm test` 不再含 `e2e/**`，新增 `test:e2e-node` / `test:all` / `test:serial`；真 `npm install`/`npm pack` 用例由 `HUB_TEST_INSTALL=1` 开启（默认 8 skipped）。
- REL-2/DEP-3：`scripts/check-{import-boundaries,domain-purity,port-signature}.mjs` 不再静默跳过；新增 `scripts/check-lockfile.mjs`、`scripts/check-selftest.mjs`（11 项正反例）。
- REL-4：`apps/web/vite.config.ts`、`scripts/dev.mjs`、`scripts/install.sh` 读 `HUB_PORT`；`scripts/deploy-hub.sh` 健康检查默认 `${HUB_PORT:-17900}`，`scripts/deploy-aliyun.sh` 的 `ALIYUN_PORT` 默认 17900。
- DEP-1：`scripts/deploy-hub.sh --bundle FILE`（`git bundle verify` → `fetch +HEAD:deploy-<sha>` → `merge --ff-only`）；`scripts/deploy-aliyun.sh --bundle <old-sha>` 负责本地打包、sha256、上传。**未在真实服务器验证**。
- DOC-1：`docs/design/accounts.md`、`docs/plan/agent-runtime-roadmap.md`、`docs/handoff/2026-11-12-current-state.md` 已纠偏。

仍未做：SEC-2（运维，需真实 SSH 凭据）、DEP-2、CAP-1..5。

## 2. B1 · 安全收口

### SEC-1 关闭 `HUB_TOKEN` 过渡通道

先分清三条通道，风险和改造成本完全不同，**不要合成一个提交**：

| 通道 | 位置 | 能做什么 | 成本 |
|---|---|---|---|
| `?token=` 查询串 | `apps/server/src/auth.ts:205`、`apps/server/src/http.ts:309` | 仅过鉴权（SSE 路径），不进 cookie | 极低 |
| `Bearer <HUB_TOKEN>` | `apps/server/src/auth.ts:203-207` | 调所有 API，但没有账号身份 | 低 |
| `/api/auth/token-login` | `apps/server/src/auth.ts:266-270` | **直接登成第一个 Owner** | 高（要改启动 guard） |

**关键事实（先读再动手）**
- `apps/server/src/account-setup.ts:13-28` 的 `hubTokenWindow()`：过渡期从 `dataDir/hub-token-since` 起算，`days` 由 `HUB_TOKEN_SUNSET_DAYS` 决定（默认 30，`apps/server/src/main.ts:643`）。**所以 `tokenLogin` 可能已经自己过期了** —— 第一步是查生产实际值，别凭文档判断。
- `apps/server/src/main.ts:135-140`：绑定非 loopback 且没有 `HUB_TOKEN` 时**拒绝启动**。这是删除 `HUB_TOKEN` 的真正阻塞点，不是登录代码本身。
- `apps/server/src/main.ts:127,747`：`token` 一直传到 `createApp`，同时给 `http.ts` 的旧中间件和 worker 通道用。
- 前端仍有完整的 token 登录模式：`apps/web/src/auth.tsx:118`（提交）、`:139`（登录方式选项 `HUB_TOKEN`）、`:20-28`（URL token 自动交换）、`apps/web/src/api.ts:344`。
- SSE 已不依赖查询串：`apps/web/src/api.ts:113` `streamUrl = () => '/api/stream'`，靠 cookie。

#### SEC-1a 删 `?token=` 查询串（可立即做）

1. `apps/server/src/auth.ts:205` 去掉 `path === SSE_PATH && tokenValid(c.req.query('token') ?? '')`；`SSE_PATH` 若只剩测试引用则一并删。
2. `apps/server/src/http.ts:309` 去掉 `c.req.path === SSE_PATH ? (c.req.query('token') ?? '') : ''` 分支。
3. `apps/server/src/http.test.ts:302` 把「查询串只给 SSE」改成「查询串一律 401」。
4. 部署后 `curl -o /dev/null -w '%{http_code}' 'http://127.0.0.1:17900/api/stream?token=x'` → `401`；浏览器登录与实时更新正常。

风险：只有拿旧链接直接开 SSE 的外部脚本会断。收益明确、成本半小时，先做这条。

#### SEC-1b 下线 token 登录（需要先改启动 guard）

1. **先确认前提**：生产 Owner 账号已存在（`/api/auth/state` 能正常登录）、Worker 已改用 pairing token（`packages/domain/src/enrollment.ts`，AC-P4 已完成）。Worker 通道是 `HUB_TOKEN` 最后一个真实用途。
2. **改 guard**：`apps/server/src/main.ts:135-140` 从「非 loopback 必须有 `HUB_TOKEN`」改为「非 loopback 必须满足其一：有 `HUB_TOKEN`，或数据目录里已有 Owner 账号」。实现上把这段移到 `accounts` 初始化之后，用 `accounts.users.firstClusterAdmin() !== null` 判断；错误文案要同步改成「先在本机注册主人账号，或配 pairing token」。
3. **删登录通道**：`apps/server/src/auth.ts:266-270` 的 `/api/auth/token-login`、`tokens` 相关的 `tokenLoginRequest` schema，以及 `apps/server/src/auth.ts:203-207` 的 `Bearer` 分支。
4. **删前端**：`apps/web/src/auth.tsx:20-28,118,139`、`apps/web/src/api.ts:344`，登录页只剩邮箱密码 / 注册。
5. **测试与文档**：`apps/server/src/auth.test.ts:92-100` 改为断言 404/401；`AGENTS.md` §6、`docs/design/accounts.md:320` 同步。
6. 阿里云 `server.env` 保留 `HUB_TOKEN` 直到第 2 步发布稳定，之后再删。

**Worker 通道的前置（容易漏，漏了等于放开集群）**
- `packages/node-gateway/src/server-gateway.ts:418` 用共享令牌判定 worker；`HUB_TOKEN` 置 null 后，`packages/domain/src/use-cases/enrollment.ts:180-182` 只在**已有凭据**时拦截，没有凭据的 workerId 反而 `sharedTokenOk=true`。
- 所以在删 `HUB_TOKEN` 之前必须先把两台 Worker 绑上 `ahw_` 凭据，并把 enrollment 判定改成「`HUB_TOKEN` 为空时，无凭据一律拒绝」。这两件事顺序错了会有窗口期。

**验收**
- 旧 token 调用 `/api/auth/token-login` → 404（路由已删）。
- 干净数据目录 + `HUB_HOST=0.0.0.0` + 无 `HUB_TOKEN` 启动，应因「无 Owner」被拒绝；本机注册 Owner 后重启应成功。
- 浏览器登录 → 会话列表、SSE、Worker 在线状态全部正常。

**风险与回退**
- 主要风险是启动 guard 改错导致生产起不来。缓解：改完先用 `HUB_HOST=0.0.0.0 HUB_DATA_DIR=<生产库副本>` 在本地验证两条分支。
- 回退：guard 改动与登录通道删除分两个提交，可单独 revert。

### SEC-2 阿里云 SSH 只允许密钥

**证据**：`AGENTS.md` §6「SSH 允许 root 密码登录且服务端 OpenSSH 较老」。

**方案（运维，按顺序，避免自锁）**
1. 本地 `ssh-keygen -t ed25519 -f ~/.ssh/aliyun_ahub`（已有则复用），`ssh-copy-id` 用密码通道装公钥。
2. **新开一个 SSH 会话**验证密钥可登录、`sudo`/root 可用。
3. 编辑 `/etc/ssh/sshd_config`：`PasswordAuthentication no`、`PermitRootLogin prohibit-password`。
4. `sshd -t && systemctl reload sshd`。
5. 保留 Tailscale 通道 + 现有会话不退出，观察 10 分钟再关旧会话。

**验收**：`ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@8.213.197.187` 被拒绝；密钥登录成功。

**风险**：改错 sshd 会锁死公网入口。缓解：Tailscale（`100.110.66.47:22`）是第二条可用通道，改前确认它可用。

## 3. B2 · 工程门禁与测试可靠性

### REL-1 `npm test` 卡住

**证据**
- `package.json:19` 的 `test` glob 含 `e2e/**/*.test.ts`；其中 `e2e/server-env.test.ts` 会真实拉起 hub + worker。
- `e2e/server-env.test.ts:65`：`spawn(command, [], { env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`。
- `e2e/server-env.test.ts:73-79` 的 `stop()` 只 `process.kill(-child.pid, 'SIGTERM')`，**不等待退出、无 SIGKILL 兜底**；`pipe` 句柄因此一直开着，测试进程不退出 → `node --test` 挂住。
- 同型问题：`apps/server/src/observe-flag.test.ts:23-36` 用 `stdio: ['ignore','pipe','pipe']` 起 `apps/server/src/main.ts`，`:63` `child.kill('SIGTERM')` 后立刻 `rm(dir)`，既不等退出也可能撞上目录占用。
- 放大因素：`apps/server/src/components.test.ts:6`、`packages/node-gateway/src/components.test.ts:43,82,104,116` 跑真实 `npm install`（超时 60–120s）；默认并发下多个 npm 抢网络。

**是间歇性的，不是必现**：2026-11-12 用默认并发跑全量 `npm test` 得到 `tests 989 / pass 986 / fail 0 / skipped 3`，30.1s 退出 0。所以修的是「一旦触发就永远不返回」的根因，不是让测试变快。

**方案**
1. 抽一个测试工具 `e2e/spawn-hub.ts`（或 `apps/server/src/test-child.ts`）：
   - `stdio: 'ignore'`（这些用例靠 `/proc` 与 HTTP 断言，不需要管道）。
   - `stop()` 改成 `async`：发 `SIGTERM` → `Promise.race([once(child,'exit'), timeout(3000)])` → 未退出则 `process.kill(-pid,'SIGKILL')` 再 `await once(child,'exit')`。
2. `observe-flag.test.ts` 同样改用该工具，并在 `rm(dir)` 前 `await stop(child)`。
3. 真实 `npm install` 的用例加环境开关：`HUB_TEST_INSTALL=1` 才跑，否则 `skip`（与 `HERMES_LIVE` 的既有约定一致）。
4. `package.json` 拆脚本：
   - `test`：四个单测 glob（不含 `e2e/`），恢复默认并发；
   - `test:e2e-node`：`e2e/**/*.test.ts`；
   - `test:all`：`npm test && npm run test:e2e-node`。
5. 保留 `--test-concurrency=1` 作为 `test:serial`，仅用于排查。

**验收**
- `for i in 1 2 3; do timeout 300 npm test; done` 三次都退出 0，无 `timeout` 命中。
- `npm run test:e2e-node` 单独跑也退出 0。
- 串行全量耗时不超过当前基线（约 87s），并记录一次并发耗时写进 `AGENTS.md` §6。

**风险**：改 `stdio` 可能让失败时看不到子进程日志。缓解：子进程日志改写到 `dir/hub.log`，断言失败时读文件拼进 message。

### REL-2 架构门禁静默跳过

**证据**：`scripts/check-import-boundaries.mjs:155-158`
```js
try { pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')); }
catch { continue; }
```
`package.json` 缺失或写坏时，该包被直接跳过——包括后面「包名不在层间依赖表里」这条本该失败的检查。

**方案**
1. 改成 `catch (e) { failures.push(...); continue; }`，`failures` 非空时以非 0 退出（脚本已有该机制）。
2. 顺手审 `scripts/check-domain-purity.mjs`、`scripts/check-port-signature.mjs` 里的空 `catch`/`continue`，同样处理。
3. 加最小回归测试：`scripts/check-*.test.mjs` 里造一个临时目录（坏 `package.json`）跑检查函数，断言非 0。若脚本不易抽函数，就加一条 `npm run check:self` 的 fixture 校验。

**验收**：临时把 `packages/domain/package.json` 改坏 → `npm run check:boundaries` 退出非 0 并指出该目录；改回后恢复通过。

### REL-3 测试污染与端口碰撞

**证据**
- `packages/adapters/acp/src/acp-runtime.test.ts:25`：`workspaceRoot: process.cwd()`；`test-fixtures/fake-agent.mjs:101` 在 `please-write:` 时 `appendFileSync(join(cwd, ...))` → 直接往仓库根写文件。
- `apps/server/src/install-artifacts.test.ts:31`：`cacheDir: join(dir, '..', \`cache-${commit.slice(0,8)}\`)`，即 `$TMPDIR/cache-<sha8>`；同提交哈希的用例共享同一缓存目录。
- `apps/server/src/observe-flag.test.ts:15`：`const port = 20000 + Math.floor(Math.random() * 20000)` — 有碰撞可能，且失败时报错难懂。

**方案**
1. `acp-runtime.test.ts`：每条用例 `await mkdtemp(join(tmpdir(),'hub-acp-'))` 作 `workspaceRoot`，`after` 清理。
2. `install-artifacts.test.ts`：`cacheDir` 放进该用例自己的临时目录（`join(dir,'.cache')`），不放到 `dir/..`。
3. `observe-flag.test.ts`：抽 `reservePort()` 助手 —— `net.createServer().listen(0)` 取端口后 `close()`，最多重试 3 次；拿到端口再传给子进程 `HUB_PORT`。
4. 全仓检查同类写法：`grep -rn "20000 + Math.random\|join(dir, '\.\.'" apps packages --include=*.ts`。

**验收**：连跑 `npm test` 两遍后 `git status --short` 为空；`ls $TMPDIR | grep '^cache-'` 无新增；随机端口用例连跑 20 次无 `EADDRINUSE`。

### REL-4 `HUB_PORT` 链路

**证据**
- `apps/web/vite.config.ts:10`：`'/api': { target: 'http://127.0.0.1:7878', changeOrigin: true }` — 不读环境变量。
- `scripts/dev.mjs:11` 透传 `process.env`，所以 server 拿到 `HUB_PORT`；只有代理写死 → `HUB_PORT=7897 npm run dev` 时前端打向 7878。
- `scripts/install.sh:38`：`Environment=HUB_PORT=7878`。
- `scripts/deploy-hub.sh:8`：`HEALTH=http://127.0.0.1:7878/api/health`，而生产是 `17900`（靠调用方覆盖）。

**方案**
1. `vite.config.ts` 用 `defineConfig(({ mode }) => ...)`，`target: \`http://127.0.0.1:${process.env.HUB_PORT ?? '7878'}\``；并把 `server.port`（5173）也允许 `WEB_PORT` 覆盖，避免多实例抢占。
2. `scripts/dev.mjs` 启动时打印实际 hub 端口与代理目标，端口不一致时直接报错退出（防止静默分裂）。
3. `scripts/install.sh:38` 改 `Environment=HUB_PORT=${HUB_PORT:-7878}`（heredoc 需要转义，注意 `install.sh` 是生成 unit 文件）。
4. `scripts/deploy-hub.sh:8` 改 `HEALTH=http://127.0.0.1:${HUB_PORT:-17900}/api/health`。

**验收**：`HUB_PORT=7897 npm run dev` → 打开 `http://127.0.0.1:5173` 能登录、SSE 有帧；`HUB_PORT=17900 scripts/deploy-hub.sh` 健康检查指向 17900。

## 4. B3 · 部署与运维

### DEP-1 bundle 部署脚本化

**背景与现状**
- 阿里云解析不了 `github.com`（`AGENTS.md` §5）。现有链路纯 GitHub：`scripts/deploy-aliyun.sh:24` `ALIYUN_REF=origin/master` → 远端执行 `scripts/deploy-hub.sh`，而 `scripts/deploy-hub.sh:39-40` 是 `git fetch -q` + `git merge --ff-only "$REF"`，这就是 `Could not resolve host` 的爆点。
- `scripts/deploy-hub.sh:8-20` 的参数解析没有 bundle 入口；仓库里也没有独立 bundle 脚本，目前靠手工四步（`docs/handoff/2026-11-12-current-state.md` §3）。
- 可复用片段已齐：快照 `scripts/deploy-hub.sh:29-36`、构建 `:44`、健康检查 `:45-51`（30×2s）、回滚 `:58-63`；上传与 ssh `scripts/aliyun-ssh.sh:40-46`；bundle 取回与 sha256 校验 `scripts/bootstrap-worker.sh:239` 与 `:196-222`。

**方案（给 `deploy-hub.sh` 加 `--bundle FILE`，不新建平行脚本）**
1. 参数解析加 `--bundle FILE`；给了 bundle 时跳过 `git fetch`/`git merge --ff-only "$REF"`，改为 `git bundle verify FILE` → `git fetch FILE "+HEAD:refs/heads/deploy-<sha>"` → `git merge --ff-only deploy-<sha>`（写法照 `scripts/bootstrap-worker.sh:239`）。
2. 新增 `scripts/deploy-aliyun.sh --bundle`：本地 `git bundle create /tmp/opencode/hub-<sha>.bundle <old-sha>..HEAD` + `sha256sum` → 用 `scripts/aliyun-ssh.sh` 上传（`cat >` 重定向，见 `:40-46`）→ 远端调 `deploy-hub.sh --bundle`。
3. 备份、构建、重启、健康检查、失败回退全部沿用现有分支，不复制逻辑。
4. 只改 `apps/web` 时加 `--skip-ci`（构建仍要跑）。

**验收**：在 `ff34492` 上跑一次「无变更 bundle」（同一 sha）稳定通过；把构建步骤临时改成 `exit 1`，应打印回滚命令且线上 HEAD 不变。

### DEP-2 Worker 代码漂移（已核实：当前不构成错配）

**事实**
- `/home/qdw/agent-hub` 在 `2d9f305 fix(acp): 恢复会话时保留运行时命令表`，工作区干净，分支 `agent-hub-worker`；与本仓库 HEAD `ff34492` 差 11 个提交（49 files，+2082/−269）。
- 差异集中在 `apps/web/src/**`、`apps/server/src/main.ts`、新增 `apps/server/src/session-environment.ts`、`packages/domain/src/use-cases/hosting.ts`（`environmentRevision` 比对）、`packages/domain/src/tool.ts`（授权 TTL 1h/12h → 7d/30d）、`packages/storage-sqlite/src/schema.ts:65`（新列）。
- **`apps/worker/**`、`packages/node-gateway/**`、`packages/adapters/**`、`packages/contract` 零改动**，`packages/node-gateway/src/server-gateway.ts:435` 的 `PROTOCOL_VERSION` 未变 ⇒ 现在不会行为错配。

**方案（降级为运维卫生）**
1. 下一次改动落到 `adapters/`、`node-gateway/` 或 `worker/` 时，必须同时更新 `/home/qdw/agent-hub` 并 `systemctl --user restart agent-hub-worker`；把这条写进部署检查清单（`AGENTS.md` §5）。
2. Worker 在 hello 里上报 `commit`，机器页显示；与 Hub HEAD 不一致时提示「Worker 落后」而不阻断（需先确认上报格式，`grep -rn "commit" apps/worker/src`）。
3. `AGENTS.md` §2 表格加「代码 HEAD」列，部署后人工更新。

**验收**：`/api/workers` 能看到两台 Worker 的 commit；把本地 Worker 切到旧提交，机器页出现「落后」提示。

### DEP-3 lockfile 一致性

**背景**：`AGENTS.md` §6 记录过 `@agent-hub/connector-github` 缺条目导致 `npm ci` 报缺包。**当前已核实一致**：lockfileVersion 3，16 个 workspace 与 16 条 `node_modules/@agent-hub/<name>` 条目一一对应，`missing=[]`、`stale=[]`（`package-lock.json:110` 的 connector-github 条目已补，workspace 块 `:6773`）。

**所以这是预防性门禁，不是现成缺陷**：`npm ci` 会先清空 `node_modules`，半途缺包等于服务停摆，所以值得挡在 CI/部署前。

**方案**
1. 加脚本 `scripts/check-lockfile.mjs`：读 `package.json` 的 `workspaces`，逐个断言 `package-lock.json` 的 `packages` 里有 `node_modules/<name>`；缺则非 0 退出。
2. 接进 `npm run check`（作为 `check:lockfile`）。
3. 服务器 `npm ci` 前先跑该脚本，提前失败而不是半途清空 `node_modules`。

**验收**：临时删掉 lock 里一条 workspace 条目 → `npm run check:lockfile` 非 0；恢复后通过。

## 5. 验证基线（每批必跑）

```bash
npm run check           # 含 check:lockfile（DEP-3 之后）
npm run typecheck
npm run typecheck:web
npm test                # B2 之后不再需要 --test-concurrency=1
npm run test:e2e-node
npm run build
```

E2E（改了 server/web 时）：

```bash
E2E_PORT=7896 E2E_DATA_DIR=/tmp/agent-hub-e2e-data \
  npx playwright test e2e/auth.spec.ts e2e/chat.spec.ts --reporter=list
```

部署（B1/B3 之后）：

```bash
ALIYUN_ENV_FILE=/tmp/opencode/aliyun-tailscale.env scripts/deploy-bundle.sh <old-sha>
# 验证：/api/health 200、能登录、/api/workers 两台 online、新会话收到第一条回复
```

## 6. B4 · 文档纠偏

只改状态与命名，不改设计结论。改动清单见 §8。

## 7. B5 · 能力缺口（P2，未排期）

| 项 | 设计文档 | 开工前提 |
|---|---|---|
| CAP-1 P5 别名 UI + 热加载 | `docs/plan/agent-runtime-roadmap.md:100-102` | 需要新增 Worker 命令 + 持久化 + 运行时重建；`ACP_AGENTS` 能执行任意命令，属信任边界，UI 必须限 Owner |
| CAP-2 第二个 codec | `docs/design/acp-runtime-codec.md:212` | 拿到 Claude Code / Codex 的具体私有格式；先落地 CD-1（`toolNames` 改只读，`docs/design/acp-runtime-codec.md:90`） |
| CAP-3 发送反馈 P1 | `docs/design/message-send-feedback.md:143-199` | 依赖顺序 MS-1（协议）→ MS-2（domain 两段）→ MS-3（幂等）→ MS-4（对账）；验收见 `:243-248` |
| CAP-4 环境刷新 P1/P2 | `docs/design/session-environment-refresh.md:293-307` | 先做 SE-0.4 只读接口（`:275`，成本最低、UI 已设计好），再 P1-1 目录缓存 |
| CAP-5 小项 | — | 高对比度手开关、右侧详情抽屉、离线/弱网 E2E |

**明确不做**：持久 MCP 连接 + `list_changed`（`docs/design/session-environment-refresh.md:305-307`，需要真实需求）；更多 OAuth / Passkey（`docs/design/accounts.md:323`）；限流落库（`:194`，触发条件是多实例部署）。

## 8. 文档与代码不一致清单

| 位置 | 文档说法 | 代码事实 | 处理 |
|---|---|---|---|
| `docs/design/accounts.md:318` | AC-P2 运营后台「待做」 | `apps/web/src/admin/{users,workers,settings,overview,assets}.tsx` 已存在 | 改为已完成，核对残留范围 |
| `docs/design/accounts.md:320` | AC-P4 Worker 接入「待做」 | `packages/domain/src/enrollment.ts`（`PAIRING_PREFIX = 'ahw_pair_'`）已落地 | 拆成「已完成」+「彻底移除 `HUB_TOKEN`」（由 SEC-1 关闭） |
| `docs/design/accounts.md:322` | AC-P6「个人令牌」待做 | `packages/domain/src/api-token.ts`（`API_TOKEN_PREFIX = 'ahp_'`）+ `apps/web/src/tokens-dialog.tsx` | 改为已完成 |
| `docs/design/accounts.md:344` | 「目前没有邀请系统」 | `packages/domain/src/use-cases/team.ts:221 acceptInvite`、`InviteRepository`、`allowOverLimit`（`accounts.ts:196`） | 改为已实现 |
| `docs/design/accounts.md:3` | 「P4 起待做」 | P4 主体已实现，只剩 `HUB_TOKEN` 移除 | 与 `:320` 一并修正 |
| `docs/plan/agent-runtime-roadmap.md:113-118` | 编排工具「待做」，用 `list_agent_profiles` 命名 | 已实现为 `agent.list_profiles` / `agent.inspect_runtime` / `agent.activity` / `agent.spawn` / `agent.set_option` | 统一命名，删掉重复条目 |
| `docs/plan/agent-runtime-roadmap.md:99-100` | 「别名是启动配置，改完需重连」与「未做热加载」并列 | 同一件事的两种表述 | 合并为一条 |
| `docs/handoff/2026-11-12-current-state.md:18` | 989 单测 / 986 pass | 两套口径都真实：`npm test` 含 `e2e/**/*.test.ts` 多 6 个；不含时为 983 / 980 pass / 3 skipped | 注明两套口径 |

## 9. 排期建议

| 批次 | 内容 | 人·天（含 AI 辅助） | 前置 |
|---|---|---|---|
| B1 | SEC-1a 查询串（0.5h）、SEC-1b 启动 guard + 下线 token 登录、SEC-2 SSH 收口 | 1（含本地 guard 双分支验证与灰度观察） | 无 |
| B2 | REL-1 卡住根因、REL-2 门禁、REL-3 污染、REL-4 端口 | 1 | 无（与 B1 并行可行） |
| B3 | DEP-1 `--bundle` 分支 + `deploy-aliyun.sh --bundle`；DEP-2/3 降级为运维卫生与预防门禁 | 0.5（仅 DEP-1）/ 0.25（DEP-3） | B2 完成（用修好的测试验收） |
| B4 | DOC-1 文档纠偏 | 0.5 | SEC-1 定稿（影响 accounts P4 描述） |
| B5 | CAP-1..5 | 按需求 | B1–B4 完成 |

**先做哪个**：B1 与 B2 无依赖，可以两条线并行；SEC-1 有灰度观察窗口，正好用观察期做 B2。

**不用等排期的两项**：SEC-1a（删 `?token=`，半小时）和 REL-2（门禁静默跳过，半小时），互不重叠，可以现在就落地。

