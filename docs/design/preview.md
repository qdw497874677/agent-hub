# 预览：把 worker 上的本地服务暴露到页面里

状态：设计稿（待确认）
日期：2026-11-14

## 1. 要解决的问题

会话在 worker 上跑 agent、构建前后端。用户想看「刚改完的样子」，现在只能自己开终端找端口，
或者在手机上手动拼 IP。

目标：

1. 会话里跑起一个 dev server（Vite / Next / uvicorn / `npm run dev`）后，能在 hub 页面上直接打开；
2. 能给出一个可分享的链接（同一个 hub 的登录用户可访问，必要时可临时公开）；
3. 不动用户代码：不需要改 `base`、不需要装客户端、不需要开 ssh 隧道。

非目标（v1 明确不做）：

- 生产发布（`prod` 域名、构建产物托管）——那是另一条产品线（Devin Apps / Replit Deployments）；
- 在 worker 上开放**任意**端口给公网（只暴露用户显式登记的回环端口）；
- 多副本/负载均衡。

## 2. 为什么不选另外三条路

| 方案 | 代表 | 为什么不用 |
| --- | --- | --- |
| 路径前缀反代 `/preview/<s>/<port>/` | 常见自建做法 | Vite/Next 的绝对资源路径、`redirect`、cookie `path`、HMR ws 路径全要重写，任一处理错就白屏；调研结论也是「重灾区」 |
| 每端口一个子域 `3000-x.hub.dev` | Codespaces、Gitpod | 需要泛解析 DNS + 通配证书；我们的部署是 `127.0.0.1:7878` 与 `8.213.197.187:17900`，没有域名 |
| 客户端本地隧道 | VS Code dev tunnel、`ssh -R` | 要装客户端；分享给别人时要对方也装 |

## 3. 方案：端口映射（hub 每预览一个监听端口）

hub 为每个预览链接在本机**多开一个监听端口**（例如 17901），把该端口的流量原样转发到
目标 worker 的 `127.0.0.1:<worker_port>`。浏览器看到的是一个独立的 origin：

```
http://8.213.197.187:17901/          ← 用户/iframe 打开
http://8.213.197.187:17901/@vite/client   ← 路径不变，无需重写
ws://8.213.197.187:17901/            ← HMR 天然通
```

好处：**路径零重写、HMR 零配置、绝对路径与重定向都正确**；dev server 拿到的 `Host` 由我们
改写成 `127.0.0.1:<worker_port>`（避免 Vite `allowedHosts` 拦截），并补 `X-Forwarded-*`。
代价：需要在 hub 上放通一段端口（默认 `HUB_PORT+1 .. HUB_PORT+20`），见 §9。

## 4. 数据模型

```ts
// packages/domain/src/preview.ts（新增，纯逻辑）
export interface PreviewLink {
  readonly id: PreviewLinkId;          // 'pv_<8hex>'
  readonly sessionId: SessionId;
  readonly workerId: string;
  readonly workerPort: number;         // 1..65535，只接受回环
  readonly hubPort: number;            // hub 上分配到的监听端口
  readonly label: string;              // 'Vite' / 'API' / 用户填
  readonly source: 'detected' | 'manual';
  readonly state: 'ready' | 'stale' | 'offline';
  readonly createdAt: number;
  readonly lastSeenAt: number;
}
```

- 存储：`preview_links(id PK, session_id, worker_id, worker_port, hub_port UNIQUE, label, source, created_at, last_seen_at)`；
  会话删除时级联删（`runSessionCascade` 里加一张表）；`hub_port` 唯一，重启后沿用，不重新分配。
- 目标解析复用 `terminalTarget(deps, subject, sessionId)`（`packages/domain/src/use-cases/terminal.ts:24`）：
  同一套 `session.read` + `locationOf` 判定，不新造权限。
- 端口分配：`HUB_PREVIEW_PORTS`（默认 `${HUB_PORT+1}-${HUB_PORT+20}`），从区间里取第一个未被
  `preview_links.hub_port` 占用、且 `bind` 成功的端口；区间用尽 → `conflict('预览端口用完了')`。
  区间外一律拒绝（防止把 hub 自己的端口或系统端口占掉）。

## 5. 端口发现

三条来源，按可信度排序：

1. **手动登记**（v1 必须有）：预览面板输入端口 + 标签，`POST /api/sessions/:id/previews { port, label }`。
2. **输出探测**：worker 侧解析会话相关进程的输出与终端回显，匹配
   `(https?://)?(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})`；命中后**提议**一条链接（`source:'detected'`），
   仍需用户点「暴露」才生效（避免 agent 读日志时误触发）。
3. **显式声明**（后续）：项目配置 `scripts[].previewPort`，同学 T3 的 `previewUrl` 但只存端口。

任何来源都要在 worker 侧过一次校验：该端口在 `/proc/net/tcp{,6}` 里处于 `LISTEN`，且地址是回环
（`127.0.0.1`/`::1`）或 `0.0.0.0`（后者按回环处理，因为转发发生在 worker 本机）。监听在其它
网卡地址上的服务默认不代理（避免把 worker 的内网服务带出来）；要暴露必须显式勾「允许非回环」。

## 6. 传输层：worker 主动再开一条出站 WS

不复用 `/worker` 那条连接：它是 JSON 帧 + 严格请求-回复（`packages/contract/src/rpc/channel.ts:35`
默认 30s 超时），页面加载的几十个资源会和 agent 事件、prompt 抢同一条队列（队头阻塞）。

新增路径 `ws://<hub>/preview`：worker 启动时按 `HUB_URL` 推出地址与 `/worker` 同源，用**同一份
worker 凭据**握手（`Authorization: Bearer <ahw_…>`，与 `worker-enroll` 一致），hub 侧校验后
把它挂到 `workerId` 上。协议（`packages/contract/src/wire/preview.ts`，新增）：

```ts
// hub → worker
{ kind: 'preview_open';  streamId: string; port: number; host?: string }
{ kind: 'preview_pause'; streamId: string }
// worker → hub
{ kind: 'preview_data';  streamId: string; data: string }   // base64，单帧 ≤ 64KiB 原始
{ kind: 'preview_end';   streamId: string; status?: number; message?: string }
{ kind: 'preview_ack';   streamId: string }                  // 允许再发（简单窗口=1）
```

- 每个 HTTP 请求/WS 连接 = 一个 `streamId`，`preview_open` 里带原始路径、方法、头、body 摘要
  （或分块 `preview_body`），worker 用 `node:http` 连 `127.0.0.1:port` 转发；
  WS 升级则 worker 建一条 `net.connect` 双向隧道，二进制帧 base64 包一层。
- 背压：worker 侧同一时刻只允许 4 个 in-flight 帧，hub 侧看 `socket.bufferedAmount`，超 1MiB 发
  `preview_pause`，降到 256KiB 发 `preview_resume`。
- 连接断开：hub 标记该 worker 所有链接 `offline`；worker 重连后按需重开流，历史链接的 `hub_port` 不变。

如果之后发现「多开一条 WS」在 worker 侧不可行（比如某些反向代理只放行 `/worker`），退回单连接
模式（`preview_*` 帧走 `/worker`），但要接受队头阻塞，并把预览限流到 1 个并发流。

## 7. hub 侧代理

- 每个 `hub_port` 起一个独立 `http.Server`（`apps/server/src/preview-proxy.ts` 新增），与主 server
  共享鉴权工具，不共享 Hono 的中间件（避免 CSRF 与 SPA 兜底）。
- HTTP：逐跳头（`connection`/`transfer-encoding`/`keep-alive`/`upgrade`）不透传；`Host` 改写成
  `127.0.0.1:<worker_port>`；补 `x-forwarded-for/proto/host`；**剥掉**上游的
  `x-frame-options` 与 CSP 里的 `frame-ancestors`（我们自己的页面要 iframe 它），其余 CSP 原样。
- 流式：`text/event-stream` 与 chunked 直接边收边写，不缓冲整包；HTML 回包加 `cache-control: no-cache`。
- WS：`upgrade` 事件里按同一套鉴权后建立隧道，`permessage-deflate` 关闭（透传更简单）。
- 上游不可达 / 端口不再监听：返回 502 页面「服务没在跑：在终端里重新启动，或换一个端口」，
  同时把 link 标 `stale`。

## 8. 鉴权与公开链接

- 默认**私有**：访问 `hub_port` 时校验 `hub_login` / `__Host-hub_login`（复用
  `apps/server/src/terminal-bridge.ts:130-142` 的 `loginTokenOf`），再按链接所属会话判 `session.read`；
  Origin 校验复用 `originMatches`（缺 Origin 只认回环，防 DNS rebinding）。
- 未登录 → 302 到 hub 的登录页，带上 `next=<preview url>`。
- 公开分享（P3）：`POST /api/sessions/:id/previews/:linkId/share` 签发 `pv_` 开头的一次性令牌
  （HMAC + 过期时间，默认 24h，可撤销），链接形如 `…/__hub?share=pv_…`；令牌只对该 linkId 有效。
- iframe 用的同源页面（可选）：`…/__hub/frame?session=<id>` 里做一个带工具栏的框架，避免第三方
  页面自己设 `X-Frame-Options` 时整块空白（工具栏里给「在新标签打开」）。

## 9. 部署

- `HUB_PREVIEW_PORTS=17901-17920`（默认按 `HUB_PORT` 推），需要在防火墙/安全组放通这段 TCP；
  阿里云是本项目唯一公网部署，脚本里说明「不放通就只能在 hub 主机本机访问」。
- 端口映射只监听 hub 的**同一个绑定地址**（`HUB_HOST`），不要额外开 `0.0.0.0`。
- 风险提示：预览链接 = 该 dev server 的全部能力（可能读到工作空间文件）。默认私有 + 逐请求鉴权
  是底线；公开分享必须显式、可撤销、有到期时间。

## 10. UI

- 会话页新页签「预览」（`apps/web/src/atoms/session-tabs.ts` 的 union/数组、`sessionTabLabel`、
  `focus.tsx` 的 `tabs` 过滤与面板）：列表显示「端口 · 标签 · 状态 · 最近活跃」，操作
  「打开 / 复制链接 / 嵌入 / 移除」；顶部一行说明「这些链接对登录用户可见」。
- 空态给两条路：「在终端里跑起来，我们会自动发现」+「手动填端口」。
- 画布卡片（P3）：卡片底部一个「预览」按钮，点开新标签；不在卡片里塞 iframe（卡片太小、移动端更差）。

## 11. 分期

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P1 | 端口映射链路（手动登记 + 单/多端口监听 + HTTP/WS 转发 + 私有鉴权）+ 会话页页签 | 1.5 天 |
| P2 | 输出探测 + `/proc` 校验 + 失效检测（`stale`/`offline`） | 1 天 |
| P3 | 公开分享令牌 + 画布入口 + iframe 框架页 | 1 天 |
| P4 | 路径前缀兼容模式（只在只放通单端口的环境启用）+ 项目级 `previewPort` 声明 | 1.5 天 |

## 12. 验证

1. 单测：端口分配（区间外/占用/用尽）、`Host` 改写与跳头过滤、鉴权（未登录/跨会话）、
   `frame-ancestors` 剥离、`/proc/net/tcp` 解析、背压窗口。
2. 端到端（e2e）：起一个 `node -e` 的最小 HTTP server + 一个带 WS 的 server，会话里登记端口 →
   hub_port 上取到内容（含 200/404/自定义头）→ WS 回显 → 删除链接后 502 → 会话结束后链接变 `offline`。
3. 真机：Vite dev server（HMR 改动后浏览器自动刷新）+ Next（`/_next/webpack-hmr`）各跑一次。
