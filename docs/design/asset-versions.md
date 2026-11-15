# 会话资产：不可变版本目录（#225 M2–M3）

状态：设计（2026-11-15）。对应 issue #225 的 M2（会话记录的版本 ≠ 实际版本）与 M3（部分运行时静默丢资产）；安全前置见 #223。

## 1. 问题

Worker 上每个资产固定落一处（`packages/node-gateway/src/worker-assets.ts`）：

- `skills/<name>`、`project-skills/<id8>/<name>`、`instructions/<slot>.md`
- 换钉是原地 `rename` 覆盖（`:120-138`），卸载/删除直接 `prune()`（`:141-166`）。
- Grok / Codex / Hermes 把 SKILL.md 的**绝对路径**写进系统提示，让 agent 自己读（`grok-runtime.ts:17-33`、`codex-runtime.ts:544-560`、`hermes-runtime.ts:74-90`）。

于是「会话中途换版本」= 正在跑的会话读到新内容，或者读到已经不存在的文件；`session_assets` 记的是 `board.installed` 的 digest，但 `current()` 不校验 digest，两边可以不一致。

## 2. 决策

**内容寻址的不可变目录**：路径里带 digest 前缀，任何一次 `sync` 都不覆盖已有内容。

```
<root>/assets/<sha256-12>/…        # 单个资产的展开内容，只写一次
<root>/skills/<name> -> ../assets/<sha>/ # 兼容旧路径的符号链接，指向「当前」
```

- 新会话：`start_session` 带 `assetIds`（id + digest），Worker 把 `skills/<name>` 链接到对应版本；旧链接由新会话的 sync 更新，不影响已在跑的会话（它们拿到的是版本化路径，见下）。
- 运行中的会话：适配层拿到的路径从「`skills/<name>`」改为「版本化根 `<root>/assets/<sha>/skills/<name>`」。这一步需要协议里带 `assetRoots: {id, digest, root}[]`（v3 协议新增字段，缺省时退回旧路径并记警告）。
- 清理：`prune()` 改为引用计数——只删除没有被任何 `session_assets` 记录引用、且不是最近 N 次 sync 的版本；每次 sync 后跑一次。
- digest 校验：`current()` 返回 `{path, digest}`；`session_assets` 的 digest 与之一致才算可复用，不一致按 stale 重同步。

## 3. 分期

- A（本 issue 的 M2）：只做「不可变目录 + 版本化路径 + 引用计数」，协议加 `assetRoots`，适配层优先用版本化路径。
- B（M3）：Grok / Codex / Hermes 三个适配器把 SKILL.md 注入改为「读内容进提示」或「版本化路径」；缺资产时明确报错，不静默丢。
- C（#226 P2）：每会话独立 `AssetSet`（绑定在会话/Bot 上），Worker 侧按 `AssetSet` 物化目录。

## 4. 风险

- 磁盘增长：版本化目录会累积；引用计数 + 最近 N 次保留 + 定时清理兜底。
- 路径长度：Windows 不在此列（Worker 是 Linux），但要限制 digest 前缀长度（12 位）。
- 旧 Worker：不认识 `assetRoots` 时退回旧路径（行为同今天），协议升版本时要保证「不懂的字段忽略」而不是拒帧。
