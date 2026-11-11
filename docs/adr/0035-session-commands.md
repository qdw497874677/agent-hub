# ADR 0035：运行时斜杠命令透出

- 状态：事件模型、ACP 映射、输入框菜单已实现（2026-11-11）。
- 相关：ADR 0007（可调项来自 agent）、ADR 0020（旁路事件）、ADR 0034（子代理）

## 1. 问题

Hub 的 `/` 菜单原来只有三个平台动作：`/interrupt`、`/new`、`/fork`。OpenCode 等运行时自己还有 `/init`、`/review`、`/compact` 这类命令，用户在 Hub 里看不到，只能记住名字手打。

运行时命令是**会话级、会变化**的：agent 在 `session/new` 之后通过 ACP `available_commands_update` 报一份快照，之后还可能整表替换。它不能写死在 Web 常量里。

## 2. 事件

新增一个旁路事件，沿用 journal 的持久化与补帧：

```ts
type SessionCommand = {
  name: string;
  description?: string;
  hint?: string;   // 命令接受参数时的输入提示
};

{ kind: 'commands'; commands: SessionCommand[] }
```

- 后到的 `commands` 事件整表替换前一份；空数组表示运行时撤回了全部命令。
- 它是旁路事件：不进对话块、不算“有产出”、不改变 `awaiting`。
- 不支持的运行时完全不发这个事件，行为不变。

## 3. ACP 映射

`mapAcpUpdate` 识别标准 ACP `sessionUpdate: 'available_commands_update'`：

- `availableCommands[].name` 必填，空名字丢弃；
- `description` 保留；
- `input.hint` 保留为 `hint`；
- 非法/超长字段截断或丢弃。

## 4. UI

- `LiveSession.commands` 从历史/实时帧维护最新快照。
- `/` 菜单把运行时命令追加在平台命令之后；同名时平台命令优先（例如运行时也报 `new` 不会覆盖 Hub 的 `/new`）。
- 命令带 `hint` 时，选中只补全 `/name `，让人继续写参数；不带 `hint` 时选中即发送 `/<name>`。
- 菜单只是入口；真正的执行仍由运行时收到 `/name` 文本后决定。

## 5. 代价

- 多一个事件变体；所有 adapter 不实现也能工作。
- 命令列表会随 journal 持久化，刷新/重连后仍能看到；代价是每次快照一条事件（通常只有一次）。
