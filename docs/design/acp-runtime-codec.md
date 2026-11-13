# ACP Runtime Codec（P6b）

> 状态：设计稿 · 2026-11-11
> 目标：把 runtime 私有的 ACP 扩展映射到 Hub 的通用事件，不让核心继续堆 `if (agent === 'opencode')`。
> 关联：`docs/plan/agent-runtime-roadmap.md` P6b、ADR 0034、`docs/design/runtime-adapter-contract.md`

## 1. 边界

先明确三层职责：

```text
ACP transport
  └─ AcpSession：子进程、JSON-RPC、会话生命周期、重放
       └─ Runtime Codec：私有通知/工具/选项 → 通用语义
            └─ Generic mapper：标准 ACP → SessionEvent
                 └─ Hub journal / live-core / Web
```

- **Transport**：`@agentclientprotocol/sdk` + `AcpSession`，不关心 vendor。
- **Generic mapper**：`map-acp.ts`，只处理 ACP 标准字段；不认识就降级。
- **Runtime Codec**：一个 runtime 一份，处理它自己的私有扩展和非标准语义。

Codec 不是网络层，也不改变 ACP 握手；它只在“收到一条 update”和“上报一个 descriptor”之间做翻译。

## 2. 为什么不把所有逻辑塞进 `mapAcpUpdate`

`mapAcpUpdate` 是纯函数，适合结构映射：

- `agent_message_chunk` → `text`
- `tool_call` → `tool_call`
- `tool_call_update` → `tool_result`

但下面这些不是纯结构问题：

- OpenCode 的 `opencode/session/child_update` 扩展通知表示子会话，需要维护 start/end 状态。
- 父工具 `subagent` 的完成内容里才有 child id，需要和前面的事件配对。
- Claude 的 `Task` 工具和 OpenCode 的 `subagent` 都是子代理，但参数/生命周期不同。
- 不同 runtime 的 plan/todo、usage、命令通知格式不同。

这些需要“每个 runtime 一个状态机”，不适合继续塞进通用函数。

## 3. 接口

### 3.1 Codec 工厂

Codec 是**代码**，不是 `ACP_AGENTS` JSON。`ACP_AGENTS` 只能配置数据，不能注入代码。

```ts
export interface AcpRuntimeCodec {
  /** 稳定 id，用于日志/诊断/测试。 */
  readonly id: string;

  /** 每个 ACP 会话一份状态。 */
  session(): AcpSessionCodec;

  /** 可选：runtime 自报的 descriptor 修正（模型别名、能力、默认值）。 */
  descriptor?(descriptor: AgentDescriptor, config: AcpAgentConfig): AgentDescriptor;

  /** 可选：map-options 之后的语义修正；静态能表达的继续用 optionOverrides。 */
  options?(options: readonly RuntimeOption[], config: AcpAgentConfig): readonly RuntimeOption[];
}
```

### 3.2 会话级 Codec

```ts
export interface AcpCodecContext {
  readonly update: Record<string, unknown>;
  readonly meta: unknown;
  readonly toolNames: ReadonlyMap<string, string>;
}

export interface AcpCodecResult {
  /** 已经翻译好的 Hub 事件；返回后不再走通用 mapper。 */
  readonly events: readonly SessionEvent[];
}

export interface AcpSessionCodec {
  /**
   * 能处理就返回结果；返回 null 表示“这是标准 ACP，交给通用 mapper”。
   * 抛错由 AcpSession 捕获并降级，不允许 codec 打断会话。
   */
  decode(context: AcpCodecContext): AcpCodecResult | null;

  /** 本轮结束/进程退出时收尾，例如给所有 running 子代理发 end。 */
  finish(status: 'completed' | 'failed' | 'cancelled'): readonly SessionEvent[];
}
```

`toolNames` 已改成 `ReadonlyMap`（`AcpCodecContext.toolNames` 与 `AcpSessionCodec.childUpdate` 的第二个参数都是），
codec 只读、不负责维护；写入收敛在 `map-acp.ts` 内部的 `rememberToolName()`，只有持有真实 `Map` 的 runtime 会生效。

### 3.3 配置选择

```ts
export interface AcpAgentConfig {
  // ...
  readonly codec?: AcpRuntimeCodec;
}
```

- `ACP_AGENT_DEFAULTS` 的 OpenCode 配上 `opencodeCodec`。
- `ACP_AGENTS` 解析时**忽略** `codec` 字段，避免远程配置执行代码。
- 没有 codec 的 runtime 走当前通用路径，行为不变。

## 4. 数据流

```text
session/update
  │
  ├─ config_option_update ──→ mapAcpOptions → codec.options? → onOptions
  │
  ├─ replaying? ─────────────→ drop
  │
  ├─ codec.session().decode()
  │     ├─ 返回 events ──────→ push events（标记 produced）
  │     └─ null
  │
  └─ mapAcpUpdate() ─────────→ push events（标记 produced）
```

Codec 的 `decode` 返回 `events` 时，runtime 仍然负责：

- `PRODUCING` 判断
- `lastMessageId` 提取
- queue 推送
- `subagent` 事件的持久化

Codec 不直接写 journal，也不直接调用 `onOptions`。

## 5. OpenCode codec

把现在 `acp-runtime.ts` 里的逻辑原样迁入 `codecs/opencode.ts`，行为不变：

```ts
export const opencodeCodec: AcpRuntimeCodec = {
  id: 'opencode',
  session: () => new OpenCodeSessionCodec()
};
```

`OpenCodeSessionCodec` 持有：

- `subagents: Map<id, { meta, agent?, ended }>`
- `activeSubagent: { toolCallId, agent?, childId? } | null`

`decode` 顺序：

1. `readSubagentMeta(meta)` 成功：
   - 第一次见 → 产出 `subagent start`
   - 然后 `mapAcpUpdate(update, toolNames, child.id)`
   - 返回 `events`
2. 否则看 `tool_call` / `tool_call_update`：
   - 从 title/rawInput 识别父 `subagent`/`task`
   - completed/failed 时从 `<subagent sessionID="…">` 或 active child 找 id
   - 产出 `mapAcpUpdate(...)` + `subagent end`
3. 其他 → `null`

`finish` 给所有未结束子代理发 end。

### 迁移后的直接收益

- `acp-runtime.ts` 不再 import `readSubagentMeta` / `AcpSubagentMeta` / `subagentIdFromToolContent`
- `map-acp.ts` 不再包含 OpenCode 专属的 `_meta` 读取
- OpenCode 的行为有一份独立 fixture 测试

## 6. descriptor / options 钩子

这一步不急着改行为，只留扩展点：

- `options` 在 `mapAcpOptions` 之后调用，用于静态 `optionOverrides` 表达不了的逻辑。
- `descriptor` 在 `acpDescriptor` 之后调用，用于模型别名/能力修正。
- 如果某个 runtime 只需要改 label/category，继续用 `optionOverrides`，不要写 codec。

## 7. 错误与安全

- Codec 抛错：`AcpSession` 捕获，推一条 `diagnostic`，然后回退通用 mapper；不能断会话。
- Codec 不读环境变量、不读磁盘、不执行命令；只做纯数据转换。
- Codec 不打日志输出原始 payload（可能含用户代码/工具参数）。
- `ACP_AGENTS` 不能注入 codec；只有代码里注册的内置 runtime 能用。
- Codec 失败不重试；同一会话内只报一次诊断，避免刷屏。

## 8. 测试

### 单元

- `codecs/opencode.test.ts`
  - child meta → start + 子 text 带 `subagentId`
  - 父工具 `subagent` + completed content → end
  - 重复 child 不重复 start
  - `finish` 收尾
  - 标准 `agent_message_chunk` 返回 `null`
- `acp-runtime.test.ts`
  - fake agent `--child` 现有场景继续通过
  - 无 codec 的 runtime 行为不变
- `conformance.test.ts`
  - OpenCode 默认 config 有 codec id
  - `ACP_AGENTS` 自定义条目不会带 codec

### 集成

- `e2e/subagent.spec.ts` 保持通过（用 fake agent 的 `--child` 场景）
- 真实 OpenCode probe 只作为手工验证，不进 CI

## 9. 迁移步骤

1. 新增 `codec.ts` 接口与空实现。
2. 把 OpenCode 的 `readSubagentMeta`、`subagentIdFromToolContent`、子代理状态机迁到 `codecs/opencode.ts`。
3. `AcpSession` 改成“先 codec，后通用 mapper”。
4. `config.ts` 给 OpenCode 挂 codec；`ACP_AGENTS` 解析保持忽略。
5. 跑 `typecheck`、ACP 单测、子代理 E2E；要求行为零变化。
6. 更新 ADR 0034 / roadmap，把 P6b 标成“基础设施完成”。
7. 接下一个 runtime 时再写第二个 codec；没有具体需求前不写空钩子。

## 10. 不做什么

- 不做通用的“脚本 transformer”（会变成任意代码执行）。
- 不把 Paseo 的 provider plugin 协议整套搬过来。
- 不让 codec 直接操作 Hub session/workspace/权限。
- 不为了“看起来统一”把标准 ACP 也重写一遍。

## 11. 验收

- 核心 `acp-runtime.ts` 没有 vendor 名字分支。
- OpenCode 子代理行为与现在一致。
- 新增 runtime 的私有格式只改 `codecs/<runtime>.ts`。
- `ACP_AGENTS` 仍然只能配置数据，不能执行代码。
- 全量单测 + 子代理 E2E 通过。
