# Bot 的长期记忆：设计（v1，只定边界，不实现）

- 状态：草案（设计先行；实现等 #221 收尾）
- 相关：ADR 0037（Bot 是团队级成员、由 Agent 驱动）、ADR 0036（渠道 / 目标 / 投递内核）

## 1. 为什么需要

ADR 0037 把 Bot 定义成「具名、常驻、**有记忆**、按项目授权」的成员。现在的实现只有两半：

- 会话内的上下文：`session.options` + journal（随会话生灭）；
- 上下文设置：`botContextSettingKeys(projectId, name)`（`packages/domain/src/use-cases/context.ts:87`）按「项目 + 名字」存文本，靠名字寻址，不按 `botId`。

缺的是：**跨会话、跨项目授权、按 bot id 归属的长期记忆**。没有它，Bot 每次被叫到都从零开始，"常驻"只剩"进程还活着"。

## 2. 目标与非目标

目标：

1. Bot 能记住「事实、偏好、项目知识」，下次在任何被授权的项目里开会话都能取回。
2. 记忆有**作用域**：团队级（跟着 Bot 走）与项目级（跟着授权走，撤销授权即不可见）。
3. 写入可控：显式写（工具）、回合结束摘要（可开关）、用户手动编辑/删除。
4. 读取可控：会话启动时注入有限条，工具可按关键词检索；**不把整库塞进 prompt**。

非目标（v1 不做）：

- 向量检索 / embedding 服务（先做 SQLite FTS5 + 时间衰减，够用再加）。
- 跨 Bot 共享记忆（团队级「共享事实」是另一个特性，见 §8）。
- 自动从所有会话无差别抽取（噪声与成本都不可控）。

## 3. 数据模型

```sql
CREATE TABLE bot_memory (
  id            TEXT PRIMARY KEY,          -- bm_<16hex>
  bot_id        TEXT NOT NULL,             -- 按 id，不按名字
  project_id    TEXT,                      -- NULL = 团队级；非空 = 该项目专用
  kind          TEXT NOT NULL,             -- 'fact' | 'preference' | 'project' | 'procedure'
  text          TEXT NOT NULL,             -- 一条一句，≤ 2000 字
  source        TEXT NOT NULL,             -- 'tool' | 'summary' | 'manual'
  source_session_id TEXT,                  -- 哪次会话写的（可空：手动）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bot_memory_scope ON bot_memory (bot_id, project_id, updated_at DESC);
CREATE VIRTUAL TABLE bot_memory_fts USING fts5(text, content='bot_memory', content_rowid='rowid');
```

规则：

- 归属只认 `bot_id`；`project_id` 是**可见性**，不是归属。
- 同一 scope 内按 `text` 去重（归一化空白后相等即视为同一条，更新 `updated_at`）。
- 删除 Bot：级联删它的记忆；撤销项目授权：项目级记忆保留但不可见（重新授权即恢复），或按配置直接删——默认保留。

## 4. 写入

三条路径，全部走同一个 `rememberBotFact` 用例：

| 来源 | 触发 | 默认 |
| --- | --- | --- |
| 工具 | Bot 调用 `memory.remember { text, kind, scope }` | 开（scope 默认团队级） |
| 回合摘要 | 会话结束（`turnFinished`）时，用同一运行时抽 0–3 条「值得长期记住」的事实 | **关**，项目设置里逐 Bot 打开 |
| 手动 | Bot 页「记忆」段：新增/编辑/删除 | 开 |

约束：

- 只写「稳定事实」，不写「本次任务细节」；摘要路径要求模型输出 JSON 数组，解析失败就丢弃。
- 密钥/凭据模式（`sk-`、`ghp_`、私钥头、长 base64）在写入前 redact 并拒绝。
- 每条 ≤ 2000 字，单 Bot ≤ 2000 条；超限按 `last_used_at` 最旧淘汰。

## 5. 读取

1. **会话启动注入**：取「团队级 + 当前项目级」里 `use_count` 低、`updated_at` 新的前 N 条（默认 20，项目设置可调 0–50），拼成一段带边界标记的文本注入 system 上下文；不注入来源会话内容。
2. **工具检索**：`memory.search { query, scope?, limit? }` → FTS5 + 时间衰减排序，返回 `{ id, text, kind, scope, updatedAt }`，并把这些条目的 `last_used_at/use_count` 更新（用于淘汰，不做「记忆热度」展示）。
3. 注入是**只读副本**：会话里修改记忆必须显式调工具，不靠 prompt 里那段文本。

## 6. 权限与可见性

- 读：会话所属 Bot + 该会话项目（或团队级）。
- 写：`memory.write` 工具 scope（默认给 Bot 的 `ToolGrant`，可在 Bot 配置里关）。
- 删：Bot 的创建者/团队管理员；或 Bot 自己删自己写的（`source_session_id` 匹配）。
- 跨项目：项目 A 的记忆不出现在项目 B 的会话里，即使同一个 Bot；团队级记忆两边都可见。
- 审计：`bot.memory.write/delete` 进 audit，带 `botId`、`scope`、`sourceSessionId`，**不记正文**。

## 7. 界面

- Bot 页新增「记忆」段（只读列表 + 搜索 + 删除；来源标签：工具 / 摘要 / 手动）。
- 会话详情里显示「本次注入了 N 条记忆」，点开看清单（便于排查"它为什么记得这个"）。
- 项目设置里逐 Bot 两个开关：回合摘要写入、启动注入条数。

## 8. 与现有上下文设置的关系

- `botContextSettingKeys(projectId, name)` 保留：它是**配置**（提示词、项目说明），不是记忆，读取时机与生命周期都不同。
- 记忆写入不落在 context settings 里，避免「配置」与「事实」混在一张表。
- 未来「团队共享事实」可以做成 `project_id IS NULL AND bot_id IS NULL` 的一层，但 v1 不开，避免一开始就没有归属。

## 9. 分期

| 期 | 内容 | 依赖 |
| --- | --- | --- |
| M1 | 表 + `remember/search` 工具 + 启动注入（团队级） | #221 收尾（Bot 按 id 已就绪） |
| M2 | 项目级作用域 + Bot 页记忆段 + 审计 | M1 |
| M3 | 回合摘要写入（可开关）+ 淘汰策略 + redact | M2 |
| M4 | FTS5 排序调优 / 可选 embedding | M3 |
