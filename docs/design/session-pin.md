# 会话常驻（pinned）

状态：已落地（协议 v5）。下一步是 Worker 侧的「本地服务」原语，见文末。

## 为什么

一个任务里常常需要一个「长期在那儿」的会话：起本地 dev server、看日志、随时开端口预览。
现在的保活是**每台 Worker 一个池**：回合结束后进程留着，但

- 闲置 `HUB_SESSION_IDLE_MS`（默认 15 分钟）就被回收；
- 池子上限 `HUB_KEEPALIVE_MAX`（默认 8），超了按最久没活动先收；
- 回收会关终端并 dispose 进程树。

对「一次对话」这是对的，对「我就是要它一直开着」就不合适。所以加一个显式标记，而不是把全局阈值调大。

## 语义

- `Session.pinned?: boolean`（缺省 = 普通会话）。只有设置/取消两种状态，不参与状态机。
- Worker 收到 `start_session.pinned === true` 时：
  - 不 arm 空闲回收计时器；
  - 不进入 `trimKeepAlive` 的候选集（不占 `HUB_KEEPALIVE_MAX` 的名额）。
- 只影响**进程生命周期**：不改 `sessions.status`、不动 journal、不阻止用户停止/删除会话。
- 标记持久化在 `sessions.pinned`，只经 `setPinned` 写；整行 `save` 不碰它（避免跑着的会话拿旧快照回写把它冲掉）。
- 已经在跑的进程要等下一次重新托管（下一次说话前 `ensureHosted`）才吃到新标记；不要假装能热改。

## 接口

`POST /api/sessions/:sessionId/pin`，body `{ "pinned": true | false }`，返回 `SessionDto`。

- 权限与"说话"同一档（`session.prompt`）：会话创建者、团队 owner/admin、被授权的人。
- 审计：`session.pin`，detail 是「设为常驻 / 取消常驻」。

## 边界（写清楚，别当成常驻进程管理器）

1. **Worker 重启/升级会断**：systemd 的 `KillMode=control-group` 会把 cgroup 里的 agent 与服务一起收掉。常驻不改变这一点。
2. **不负责拉起**：机器重启后没有"恢复常驻会话"的机制；要恢复得再发一句话让它重新托管。
3. **端口与预览不绑定常驻**：预览链接按 worker+端口，不随会话状态消失；端口上的进程没了就回"服务没在跑"。
4. **长期会话会让 agent 进程常驻内存**：一个 opencode 进程几十到几百 MB；别把所有会话都钉住。

## 下一步：本地服务原语

常驻只是「别被回收」，真正长期可用需要服务是独立对象：

- Worker 侧 `ws.service.start/stop/list/status`：命令、端口、健康、日志尾、退出码；
- hub 侧记 `{taskId, workspaceId, command, port, state}`，任务页显示「本地服务」；
- 预览链接直接指向服务，而不是"会话里某个进程"；
- Worker 重启后由 hub 重新拉起（或标 stale 让用户点一下）。

在那之前，正确用法是：任务下留一条常驻会话 → 在它的终端里 `setsid nohup … &` 起服务 → 用预览页签映射端口。
