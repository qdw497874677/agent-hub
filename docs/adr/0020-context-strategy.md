# ADR 0020：会话上下文策略（ContextStrategy）与运行时接入等级

- 状态：accepted（2026-10-31，David 拍板见设计稿 §11，无未决项）
- 日期：2026-10-31
- 关联：ADR 0013（RuntimeAdapter 契约）、ADR 0017（权限）、ADR 0019（长期记忆）；设计稿 `docs/design/context-strategy.md`

## 背景

各个运行时管理会话上下文的方式不同：
- Claude Code、Codex 有原生自动压缩；
- pi 有自动压缩和扩展 API；
- billion-context-pi / acp-kernel 实现了「主动上下文剪枝」：模型决定压缩、可逆、分层。

David（2026-10-31）要求把这些统一抽象为「上下文策略」：默认只有自动压缩，也可以选 ACP 或其他知名策略。

## 决定（提议）

1. 新端口 `ContextStrategy`，和长期记忆（`MemoryService`）分开。钩子有：调用模型前改写上下文（`transform`）、`onCompact`、暴露给模型的工具、状态持久化和重放、用量预算输入。
2. 每个会话恰好一个策略，不叠加；选择顺序是 会话 > 角色 > 项目 > hub 默认。
3. 内置策略：
   - 只内置 `compaction`：默认，摘要替换，就是现在的行为；运行时有原生压缩就用原生的。
   
   候选适配器：`trim`、`tool-clear`、`summarize-window`、`paging`，以及主动上下文剪枝 `context-pruning`。剪枝**先不做**（David：「acp上下文先不做」），billion-context-pi 的调研保留作参考。
4. RuntimeAdapter 声明上下文能力，有三种模式：
   - `hub-managed`：hub 策略改写上下文；
   - `native`：运行时自己管，hub 只观察、记录；
   - `runtime-plugin`：策略装在运行时插件里，hub 下发配置、观察。
   
   新增运行时仍然 = 实现一个适配器并声明支持的模式；选了不受支持的策略时，退回 `compaction`。
5. 接入等级：
   - L1（必须）：观察用量、压缩事件、导出会话记录；能触发压缩、重启会话；记忆走 hub MCP 工具；
   - L2（可选）：hub-managed 或 runtime-plugin；
   - L3（不要求）：运行时内部机制和它自己的记忆文件，只读、只索引。
   
   「统一接入」= 全部运行时达到 L1。
6. 策略注入的引导文字是政策、不是记忆：只允许策略包里的静态模板加用量数字，有上限、可审计，不能夹带记忆。所以不违反 ADR 0019「记忆只用工具读」。
7. 策略产出（压缩摘要、原则候选）作为提炼的输入，出处按消息 id 范围记录。agent 提出的原则性规则**默认开**，通用地定义为 `principle-candidate`（不绑定具体策略），一律进人工确认后才成为 procedural 记忆。
9. 会话级只能从项目已启用的策略里选；L1 有缺口的运行时允许接入，用估算用量和重启兜底，UI 标出缺口。

## 命名

现有 `acp` 运行时适配器 = **Agent Client Protocol**（「ACP 协议」）；billion-context-pi 的 Active Context Pruning 称「主动上下文剪枝」，策略 id `context-pruning`。不单独用「ACP」指剪枝。
8. 策略和运行时插件只有 `cluster_admin` 能安装，锁版本，不自动更新，新版本只对新会话生效。

## 后果

- 正面：
  - 换策略不改运行时适配器；
  - 以后加剪枝等策略不用改端口；
  - 所有运行时都有统一的用量和压缩可见性。
- 负面：
  - 每个适配器都要补 L1；
  - grok 的协议还没查清；
  - opencode 的用量依赖 ACP 的 RFD。
- 中性：会话多一项「上下文策略」设置和一组审计事件。

## 备选

- 把上下文管理并进记忆：生命周期和所有者都不同，而且记忆已经决定不注入。
- 允许叠加多个策略：billion-context-pi 的 README 明确说两个压缩插件会互相破坏。
- 只支持 native：做不了剪枝这类策略，也就没有统一的策略选择。
