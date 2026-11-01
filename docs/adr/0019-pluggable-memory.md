# ADR 0019：可插拔的记忆机制（来源索引 + 整理条目，六边形端口）

- 状态：accepted（2026-10-31 David 拍板，见下方「David 的决定」）
- 日期：2026-10-31
- 关联：ADR 0020（会话上下文策略，与本 ADR 分开）、ADR 0017（权限）、ADR 0018（agent 间通信；会话类型、角色记忆 / 项目记忆已决）；设计稿 `docs/design/memory.md`

## 背景

多个 agent 运行时（claude、codex、grok、pi……）在 agent-hub 里协作。现在需要跨会话、跨项目的记忆：角色的工作方式、项目的架构 / 约定 / 决策 / 进度、用户偏好、持久型会话的压缩摘要。业界做法差异很大：Letta 把记忆块一直注入，Mem0 用 LLM 抽取事实并且只追加，Graphiti 用时间维度知识图谱，LangMem 按 namespace 组织，Claude Code 用 CLAUDE.md 加 auto memory，MCP 参考服务器用 JSONL 图。我们不能绑定其中任何一家，也需要让团队能替换策略。

## 决定

1. 记忆分两种：
   - **来源**：项目里已有的内容（仓库文件、docs、ADR、任务、会话记录、群消息），就地索引、不复制，内容归项目；
   - **整理条目**：提炼出的结论，带出处（`SourceRef`）链接回来源。
   - 检索时联邦查询两边。
2. 端口：`MemorySource`、`MemoryStore`、`MemoryIndex`、`Embedder`、`MemoryRetriever`、`MemoryPolicy`，由应用层 `MemoryService` 组合，它是唯一入口（权限、校验、审计都在这里）。
3. 作用域 `user / role / project / group / session`；资源 `memory:<scope>`，一律走 `can(subject, action, resource)`；新增权限点 `memory.read / write / review / forget / purge / export / source.manage`。
4. agent **只**通过 hub MCP 工具读写：`memory_search / get / write / forget / list`。任何作用域都不自动注入；`RuntimeAdapter` 契约不变（原提议的 `contextPreamble` 已移除）。
5. 默认适配器：SQLite（`node:sqlite`）+ FTS5；`sqlite-vec` 向量和 RRF 融合作为可选。外部适配器（Graphiti、Mem0）后期接入。
6. 冲突不改原文：`supersedes` + `validFrom/validTo` + 乐观锁；来源 hash 变了就标「可能过时」。
7. agent 或外部写入的内容标 `untrusted`，检索时包裹返回；`procedural` 记忆写入要人工确认。

## David 的决定（2026-10-31）

1. 只用工具读，不注入，移除 `contextPreamble`。
2. 项目记忆默认只追加，每个项目可以改为审核。
3. 角色记忆里的 procedural 要人工确认。
4. P1 只用 FTS5 检索，向量放 P2。
5. P1 来源是 ADR、docs、markdown、任务；会话记录放 P2。
6. 会后提炼**默认开**，与原推荐（默认关）不同。
   - 提炼结果一律 `untrusted`、`via: distill`、带出处；
   - 项目的 semantic / episodic 按项目模式处理：只追加模式直接生效，审核模式进审核队列；
   - 角色的非 procedural 条目直接生效；
   - procedural 和用户偏好一律进确认队列；
   - 不能自动取代 trusted 条目；
   - 有次数、token、条数、每天预算限额，可按项目关掉（设计稿 §6.1）；
   - 随会话记录来源在 P2 上线。
7. 未单独表态的两项按原推荐执行：P4 人工触发「导出到仓库」生成 PR；外部适配器先 Graphiti，再 Mem0。

无待确认项。

## 后果

- 正面：
  - 已有文档立刻可检索，不用重复维护；
  - 换存储或策略不改领域代码；
  - 每条记忆都可追溯、可审计、可导出。
- 负面：
  - 仓库在 worker 上，索引要在 worker 侧跑、经 relay 回传，读全文多一跳；
  - 中文全文检索要额外验证。
- 中性：多了一个「记忆」页和一个审核队列。

## 备选

- 直接接 Mem0 或 Zep 作为唯一实现：绑定厂商，自托管成本高，出处和权限不可控。
- 所有内容都复制进记忆库：重复、过时、与项目所有权冲突。
- 只做注入（Letta 式）：占上下文，而且不可信内容会进系统提示。

## 修订

- 2026-11-01：P2 第一批落地（设计 §13）——`staged` 暂存层、压缩摘要进 `session:`、规则版会后提炼（不调模型）+ 确认队列、每日后台整理。模型版提炼、抽检、向量、导入留到后面。
