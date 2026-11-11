# ADR 0034：会话内子代理显示

- 状态：事件模型、ACP 映射、Web 子代理卡与画布 badge 均已实现（2026-11-11）。
- 相关：ADR 0007（可调项来自 agent）、ADR 0018（协作消息）、ADR 0020（上下文策略）、ADR 0030（能力矩阵）

## 1. 问题

OpenCode / Hermes 这类运行时会在一次回复里派生子代理（subagent）去读代码、跑命令、做调研。用户需要看见“主会话里正在发生什么”，但子代理不应该变成 Hub 的独立会话：

- 它没有自己的任务、项目成员、工作空间生命周期；
- 让用户单独给它发 prompt / 中断 / 分叉，语义不清楚；
- 画布上多出一堆会话节点，会把真正的协作关系淹没。

因此子代理是**父会话 journal 里的一段结构化事件**，不是 `Session` 聚合。

## 2. 事件

```ts
type SubagentEvent = {
  kind: 'subagent';
  phase: 'start' | 'end';
  id: string;          // 运行时的 child session id / delegation id
  parentId: string;    // 父会话的运行时 id
  depth: number;
  title?: string;
  agent?: string;      // explorer / designer / oracle ...
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
};
```

子代理产生的正文、思考、工具调用、工具结果、产出物仍用原有事件，只多一个可选的 `subagentId`：

```ts
{ kind: 'text'; delta: string; subagentId?: string }
{ kind: 'tool_call'; name: string; input: string; subagentId?: string }
```

这样：

- journal 仍然是单一、按 seq 排序的流，回放/补帧/搜索不用改；
- UI 可以按 `subagentId` 把子事件折进父块；
- 不支持的运行时完全不产生这些字段，行为不变。

父工具调用（OpenCode 的 `subagent` tool）没有 `subagentId`，继续是普通 `tool_call` / `tool_result`，可作为子代理卡的锚点。

## 3. ACP 映射

OpenCode 2.2.6 在 `initialize.agentCapabilities._meta['opencode/child-session-updates']` 声明能力。子会话更新仍走 `session/update`，但：

- `params.sessionId` 是父会话 id；
- `params._meta['opencode/child-session']` 是 `{ id, parentID, depth, title? }`；
- 子工具调用的 `toolCallId` 形如 `<childSessionId>:<toolCallId>`；
- 父工具完成的内容里有 `<subagent sessionID="…" state="completed">`。

适配器因此（2026-11-11 起这些逻辑在 `AcpRuntimeCodec` 的 OpenCode 实现里，通用 mapper 不认 vendor 名字）：

1. 保留 `params._meta`，读 child meta；
2. 第一次见到 child id 时发 `subagent start`；
3. 子事件带 `subagentId`；
4. 父工具 completed/failed 或本轮结束时发 `subagent end`；
5. 其他 agent 不报 child meta 就不猜，不按 agent 名字写分支。

Hermes 的 `subagent.start/complete` 已经带 child session id，后续可升级为同一事件；当前仍保留 diagnostic 兜底。

## 4. 能力与 UI

- 能力矩阵后续增加 `subagent` 三态：OpenCode `available`、Hermes `limited`、其他 `denied`。P1 先不阻塞 UI。
- 专注对话：可折叠子代理卡，显示 agent / 标题 / 状态 / 工具数 / 耗时 / token；展开看子事件；失败或等待批准时自动展开。
- 画布卡片：只显示一个 badge（如“子代理 ×2”），不增加会话节点。
- 成本：子代理 token / 费用归父会话展示；Hub 只读观察，不直接控制子代理。

## 5. 不做

- 不为子代理建 `Session`、不放进画布会话树、不单独授权。
- 不在 P1 做子代理 UI；先保证事件写入、回放和 ACP 映射正确。
- 不解析所有运行时的私有协议；只适配明确声明并给出 child id 的运行时。
