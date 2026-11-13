# 会话终端（Web Terminal）

> 状态：评审稿 v3（2026-11-13，已按评审意见修订）。目标：会话里提供类似 VS Code 集成终端的交互式 shell，
> 跑在这条会话所在机器的会话工作目录里。

## 0. 结论先行

- PTY 在 **worker（机器）** 上；hub 只做鉴权、路由与生命周期，不解析终端输出。
- **浏览器 ↔ hub 用 WebSocket**：`/api/sessions/:id/terminal`，复用同一个 http 端口。
  `apps/server/src/main.ts:966` 的 `upgrade` 目前只放行 `/worker`，这里加分支 + **专用的**握手鉴权
  （upgrade 不经过 Hono 中间件，`request-guard.ts` 的 `originAllowed` 对缺 Origin 是放行，
  终端路径不能照抄，见 §2.3）。
- **hub ↔ worker**：开/关/改尺寸/对账用现有 **RPC 方法**（`packages/contract/src/worker-methods.ts`
  约定「新加请求-回复就在这里加一项」）；输入/输出/退出用 **单向帧**
  （`terminal_input` / `terminal_data` / `terminal_exit`，与 `event`/`metrics` 同型）。
  老 worker 对未知帧只在 `safeParse` 阶段丢弃并记日志（`worker-link.ts:470-481`），不升协议版本、不误伤会话。
- **不新增 worker 能力**：终端与 `sessions` 等价（能开 agent 会话就是能在机器上执行代码），
  权限就用 `session.read` + `sessions`；worker 是否支持用 `terminal.open` 返回 `unsupported` 探测，
  探测结果在 hub 按 worker 缓存，UI 据此隐藏页签。省掉能力闭集、预设、`drift.ts`、老凭据迁移的连带改动。
- **cwd 不进协议**：worker 用自己进程内的 `workspaces: Map<sessionId, root>`（`worker-link.ts:800`），
  再过 `WorkerFiles.check()`（realpath + `WORKER_ROOTS` 边界）；会话不在这台 worker 上跑就报错，不猜目录。
- 依赖实测：`node-pty@1.1.0` 在 Node v26.8.2（本机）与 v26.12.1 / npm 11.20.0（阿里云）都能
  `spawn('/bin/bash')` 并拿到 `/dev/pts/N`；前端 `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`。
- 一条会话一个终端（v1）；断线后 PTY 保留 30 分钟，切页签/刷新能接回原现场。

## 1. 目标与非目标

目标：

- 会话里多一个「终端」页签，打开即是一个可交互 shell（vim/top/htop、颜色、Ctrl-C、resize 都正常）。
- shell 的 cwd 就是这条会话的工作目录，与 agent、文件页签看到的是同一份文件。
- 切走页签、刷新页面、手机锁屏后回来，接回原来的 shell 现场。
- 老 worker 上不显示页签；不改变现有协议版本。

非目标（v1）：

- 多标签 / 分屏（按 `terminalId` 设计，后续可加）。
- 终端录制回放、命令历史同步、链接跳转、拖拽上传。
- 跨会话共享 PTY，或给 agent 复用这个 PTY。
- hub 本机开终端（v1 只走 worker）。

## 2. 传输与协议

```
浏览器 xterm.js  ──WS /api/sessions/:id/terminal──  hub  ──RPC + 单向帧──  机器上的 PTY（会话 cwd）
```

### 2.1 hub ↔ worker

**RPC 方法**（`packages/contract/src/worker-methods.ts`）：

| 方法 | 入参 | 返回 | 语义 |
| --- | --- | --- | --- |
| `terminal.open` | `{ terminalId, sessionId, cols, rows }` | `{ cols, rows, reused }` 或错误 `unsupported` | 开 PTY；同 id 存活则复用（幂等） |
| `terminal.resize` | `{ terminalId, cols, rows }` | `{ ok: true }` | 0 或 >1000 的尺寸拒绝 |
| `terminal.close` | `{ terminalId }` | `{ ok: true }` | 结束并回收；不存在也算成功 |
| `terminal.list` | `{}` | `{ terminals: [{ terminalId, sessionId }] }` | 对账用（见 §3 的 hub 重启） |

**单向帧**（`packages/contract/src/wire/worker.ts` 的 `discriminatedUnion`）：

| 方向 | 帧 | 字段 | 语义 |
| --- | --- | --- | --- |
| hub→worker | `terminal_input` | `terminalId`, `data`(base64) | 写 stdin，不回复 |
| worker→hub | `terminal_data` | `terminalId`, `data`(base64) | 输出块，单帧 ≤64 KB |
| worker→hub | `terminal_exit` | `terminalId`, `code`, `signal?` | 进程退出，worker 已回收 |

为什么不全用 RPC：输入是「每敲一个字节一次」，走 `request()` 会给每帧挂超时并做取消簿记；
输出是服务端主动推送，没有请求可回复。单向帧与现有 `event`/`metrics` 同型，两端各加一个 case。

base64 统一：避免 JSON 分块切断多字节字符，也避开控制字符转义；33% 膨胀 v1 接受。

**背压**（只在一处，不跨连接做反馈环）：worker 侧合并输出（16ms tick，单帧 ≤64 KB），
并**直接看自己写向 hub 的那条 ws 的 `bufferedAmount`**：>4 MB 就 `pty.pause()`，<512 KB `resume()`。
hub 侧再看它写向浏览器的 ws：>4 MB 连续 5 秒就丢弃后续输出并关掉该终端 WS（提示重连），
避免「浏览器慢」把整条 worker 链路拖死。两层各自本地判断，不发控制帧、不新增 RPC。

### 2.2 浏览器 ↔ hub（JSON 文本帧）

浏览器 → hub：`{t:'input', d:base64}`、`{t:'resize', cols, rows}`、`{t:'ping'}`。

hub → 浏览器：`{t:'ready', terminalId}`、`{t:'data', d:base64}`、`{t:'exit', code}`、
`{t:'error', message}`、`{t:'pong'}`。

`terminalId` 由 hub 生成（`<sessionId>:<n>`），v1 每条会话固定复用同一个。
WS 限制：单帧 128 KB；心跳 25s，两次不回就关。

**单写者，但不踢人**：同一 terminalId 已有客户端时，新连接直接回
`{t:'error', message:'这个终端已在另一个窗口打开'}` 后关闭。踢旧连接等于给同权限的第二个标签
一个「抢占 stdin」的口子（还能打断正在跑的 vim），不做。

### 2.3 upgrade 鉴权（不经过 Hono 中间件）

`server.on('upgrade')` 对 `/api/sessions/<id>/terminal` 依次做：

1. `guard.hostAllowed(host)`（现有重绑定防护）。
2. **Origin**：必须与 Host 同源；**缺 Origin 时只接受 loopback 连接**（`127.0.0.1`/`::1`/`localhost`）。
   不要复用 `request-guard.ts:33-34` 的 `originAllowed`——它对缺 Origin 返回 `true`（worker/curl 的语义），
   照抄等于公网无 Origin 全放行。
3. **cookie**：同时认 `hub_login` 与 `__Host-hub_login`（`auth.ts:68-80`，HTTPS 部署是后者），
   值用常量时间比较；解析出登录态后按 `session.read` 授权
   （`terminalTarget(subject, sessionId)`，见 §6）。失败回 401/403 并 `socket.end`。
4. 通过后交给 `terminalBridge.attach(...)`，自己 `new WebSocketServer({ noServer: true })`；
   与 worker 通道各用各的 `WebSocketServer`。

## 3. 生命周期

| 事件 | 行为 |
| --- | --- |
| 首次打开页签 | hub 生成/复用 terminalId → `terminal.open` → 回 `ready` |
| 页签切走 / 刷新 / 断网 | WS 关闭；PTY 保留，worker 起 linger 计时 |
| 重新打开 | 同 terminalId 重连；PTY 还在 → `ready`；worker 重启过 → 重新 `open`，前端提示「终端已重启」 |
| 空闲 `TERMINAL_LINGER_MS`（默认 30 分钟） | worker 结束进程并回收 |
| 会话 ended（hub 收到 `ended` 事件） | hub 对这条会话发 `terminal.close`，并关掉 WS（回 `exit`） |
| 用户删会话 / 同 id 被新 start 顶替 / 换机器继续 | hub 在对应用例里发 `terminal.close`（不能指望 worker 的 dispose 路径：hub 从不发 `kind:'dispose'`） |
| worker 离线 | `markOffline`（`server-gateway.ts:359-372`）关掉该 worker 的终端 WS，回 `error: 机器离线`；不在新机器自动重开 |
| **hub 重启后 worker 重连** | hub 的 Map 是空的，而 worker 上的 PTY 还活着：hub 在 worker `hello/inventory` 之后调一次 `terminal.list`，把**自己不认识**的 terminalId 全部 `terminal.close`（不能干等 linger，否则永远留着） |
| 同 terminalId 已有客户端 | 拒绝新连接（§2.2），不踢 |

为什么保留：切页签、刷新、锁屏都会断 WS，断开即杀会让交互莫名中断。
为什么不久留：孤儿 shell 占内存与句柄，30 分钟空闲足够覆盖正常使用。

## 4. 安全

- **权限**：`session.read` + worker 的 `sessions` 能力。不新增能力闭集项（见 §0）。
  只读凭据没有 `sessions`，天然开不了终端。
- **cwd**：worker 用 `workspaces.get(sessionId)`，再过 `WorkerFiles.check()`（`worker-files.ts:62`，
  realpath + 边界 + TOCTOU 防护）。会话不在这台 worker 上跑 → 明确报错。
- **env**：spawn 前剔除 `HUB_TOKEN`、`HUB_WORKER_CREDENTIAL`、`HUB_LOCAL_SECRET`、`HUB_PARENT_PID`、`HUB_URL`；
  设 `TERM=xterm-256color`、`COLORTERM=truecolor`；`LANG`/`PATH`/`HOME` 沿用。
- **资源**：worker 全局最多 `TERMINAL_MAX`（默认 16）个 PTY，超过回错误；单会话 v1 只允许 1 个。
- **审计**：开终端记一条 `terminal.open`（谁、哪条会话、哪台机器），关闭/异常退出不记（噪音太大）。

## 5. worker 侧

新增 `packages/node-gateway/src/terminal.ts`：

```ts
createTerminalHost({
  shell: string,        // TERMINAL_SHELL，默认 $SHELL 或 /bin/bash
  max: number,          // TERMINAL_MAX，默认 16
  lingerMs: number,     // TERMINAL_LINGER_MS，默认 30 分钟
  check: (path: string) => Promise<string | null>,   // 注入 WorkerFiles.check
  backpressure: () => number,                        // 返回当前 link 的 bufferedAmount
  onData: (terminalId: string, chunk: Uint8Array) => void,
  onExit: (terminalId: string, code: number, signal?: number) => void
}): TerminalHost | null
```

- `node-pty` 用动态 `import()`：装不上（缺编译产物）就返回 `null`，`terminal.open` 回 `unsupported`，
  UI 不显示页签——**降级不能拖垮 worker 启动**。
- `open`：拿 session 的 root → `check()` → 上限 → `pty.spawn(shell, ['-l'], { name:'xterm-256color', cols, rows, cwd, env })`；
  同 id 存活则 `resize` 后回 `reused: true`。
- 输出：16ms 合并；`backpressure()` 超阈值 `pause()`。
- 关闭：`kill()` 之后用 `pidtree` 兜底（交互式 shell 可能还有前台进程组）；清 Map 与计时器。
- `closeSession(sessionId)`：会话结束时一次回收该会话的所有终端。
- `apps/worker/src/main.ts`：注册 4 个 RPC 方法 + `terminal_input` 帧；进程退出 / `link.close()` 时 `disposeAll()`。
- `worker-link.ts`：会话事件循环结束时（`worker-link.ts:807-827` 一带）与 `close()`（:840-855）里调
  `terminalHost.closeSession(...)`/`disposeAll()` 作为兜底；正常路径仍以 hub 的 `terminal.close` 为准。

依赖：`packages/node-gateway/package.json` 加 `node-pty ^1.1.0`。若将来 Node 大版本没有预编译产物，
机器上需要 `python3`+`make`+`g++`，或换 `@homebridge/node-pty-prebuilt-multiarch`（只改一处 import）。

## 6. hub 侧

- 新增 `packages/domain/src/use-cases/terminal.ts`：`terminalTarget(subject, sessionId)` → `{ root, workerId }`；
  授权只到 `session.read`，内部用 `locationOf`（`use-cases/workspaces.ts:20-31`），`root === ''` 报
  「这条会话还没有工作空间」。
- 新增 `apps/server/src/terminal-bridge.ts`：
  - `attach(request, socket, head)`：握手已鉴权 → 取会话与 terminalId →
    `gateway.openTerminal(...)`（首次会探测 `unsupported` 并缓存）→ 建 WS → 桥接。
  - `Map<sessionId, { terminalId, workerId, socket, slowSince }>`；worker 帧按 terminalId 路由；
    会话 ended / 删除 / `markOffline` 时关 WS 并清理。
  - 慢客户端：浏览器 ws `bufferedAmount > 4MB` 连续 5 秒 → 关 WS（§2.1）。
- `packages/node-gateway/src/server-gateway.ts`：`openTerminal/resizeTerminal/closeTerminal/listTerminals`，
  照 `updateProvider` 的写法（在线且凭据有 `sessions` 才动，失败不 throw）；worker 重连后跑一次对账。
- `apps/server/src/main.ts:966`：`upgrade` 分支加 `/api/sessions/<id>/terminal`；其余路径维持 403。

## 7. 前端

- 依赖：`apps/web` 加 `@xterm/xterm@6` + `@xterm/addon-fit@0.11`，引入 `xterm.css`。
- `apps/web/src/session-tabs.ts` 的 `SESSION_TABS` 加 `'terminal'`，`sessionTabLabel` 加「终端」；
  `apps/web/src/focus.tsx:554-583` 的 tab 渲染与 pane 分支带上（pane 用 `hidden` 不卸载，已有先例）。
- 新增 `apps/web/src/terminal-panel.tsx`：
  - 挂载建 WS；`FitAddon.fit()` 后发 `resize`。
  - **尺寸**：`ResizeObserver` 节流 120ms；容器宽或高为 0（`display:none`）时**跳过 fit**；
    切回页签后在 `requestAnimationFrame` 里再 fit 一次，避免 0 列导致的错乱。
  - 断线：一行提示 +「重连」；`exit`：`[进程已退出（code N）]` +「新开一个」；
    `error`：显示原因，退避最多 5 次，不无限重试。
  - 主题跟现有 token（深/浅两套），字体 `ui-monospace, SFMono-Regular, Menlo, monospace`，字号 13。
  - 页签在 `session.status === 'running'`、worker 在线、且未被探测为 `unsupported` 时渲染；
    手机宽度下不放进底部快捷栏。
- 切走期间实例保留（不 dispose），只停 fit 与 resize 发送；`visited` 集合已存在（`focus.tsx:119`）。
- **手机按键条**（`(pointer: coarse)` 才渲染，跟媒体查询 `change` 实时切换）：底部一条 `h-9` 的
  `Esc / Tab / Ctrl / ↑ / ↓ / ← / → / Ctrl+C`，`flex-nowrap overflow-x-auto`，不遮挡 xterm
  （独立 `shrink-0` 块，不用 absolute）。发货走 `term.input()` → `onData` → 现有 `encodeInput`
  与断线缓存，不另开 socket；`onPointerDown` 只 `preventDefault()`（保住键盘），动作放 `onClick`
  （拖动按键条滚动不会误发 Esc）。粘滞 `Ctrl` 只作用于方向键（`\x1b[1;5A/B/C/D`，readline/zsh
  的跳词序列），一次性修饰：点任何别的键或软键盘直接敲字都吸掉，界面不会停在「灯亮着但没带
  Control」的半成品状态。`visualViewport.resize` 额外触发一次 fit（120ms 节流），键盘弹出后
  末行不被吃掉。testid：`terminal-keys`、`terminal-key-esc|tab|ctrl|up|down|left|right|ctrl-c`。
- **布局前提**：`focus.tsx` 的根容器是 `flex min-h-0 flex-1 flex-col`（不是 `h-full`），
  `app.tsx` 的内容列带 `min-h-0`；否则手机上 header + 100dvh 会多出一截，终端底部（含按键条）
  落到可视区外。e2e `e2e/terminal-mobile.spec.ts` 用 390×844 与 390×500 两个高度守住这条。

## 8. 验证

- 单测（假 pty 注入）：open 幂等、resize 非法值、linger 到期、`closeSession`、上限拒绝、越界 cwd 拒绝、16ms 合批、背压 pause/resume。
- 契约：4 个 RPC 方法 + 3 条帧的 schema 往返；老 worker 侧「未知帧只丢弃」的回归用例。
- 域：`terminalTarget` 授权（可见 / 不可见 / 没有工作空间）。
- 集成：真 server + 假 worker（`apps/server/src/test-support/spawn.ts`），WS 发 `input` 断言收到 `data`；
  会话 ended 后 WS 收到 `exit`；第二个 WS 被拒；hub 重启后 `terminal.list` 对账会关掉孤儿。
- 手工（本机 + 阿里云）：`vim`、`top`、`ls --color`、`Ctrl-C`、`Ctrl-D`、拖窗口 resize、刷新后接回、
  会话结束断开、断网重连、`yes` 背压、超过 `TERMINAL_MAX`、老 worker 不显示页签、双标签被拒。
- e2e（可选）：Playwright 开终端页签 → `echo hi` → 断言渲染出 hi。

## 9. 分期

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| T1 | `node-pty` + 契约（RPC/帧）+ `createTerminalHost` + worker 接入 + 单测 | 0.5 天 |
| T2 | 域 `terminalTarget` + hub WS 桥接（upgrade 鉴权/路由/慢客户端/对账）+ 集成测试 | 0.5 天 |
| T3 | 前端页签 + xterm + 断线/退出/尺寸 + 手工验证 | 0.5 天 |
| T4 | 文档（终稿、`AGENTS.md`、交接文档）+ 部署验证 | 0.25 天 |

## 10. 评审已定的结论

1. 不新增 `terminal` 能力，复用 `sessions` + `session.read`；支持探测靠 `unsupported` 错误码并缓存。
2. 不踢旧连接，第二个客户端直接拒绝。
3. Origin 规则为终端单独写：缺 Origin 只认 loopback；cookie 认 `hub_login` 与 `__Host-hub_login`。
4. 背压两层各自本地判断（worker 看 link 的 `bufferedAmount`，hub 看浏览器 ws），不发控制帧。
5. hub 重启后靠 `terminal.list` 对账，孤儿 PTY 立即关闭。
6. 会话结束/删除/顶替由 hub 发 `terminal.close`；worker 的 dispose 路径只做兜底。
