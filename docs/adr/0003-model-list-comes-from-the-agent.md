# 模型列表来自 agent 自己，平台不做推测

**Status**: accepted

## 背景

`Session.model` 是会话用来跑哪个模型的字符串。第一版实现里，各适配器的 `AgentDescriptor` 硬编码了一份模型清单（`claude-sonnet-4-5`、`gpt-5-codex`……），看起来齐全、可选，实际上全是猜的：平台不知道这台机器上装了哪些 provider、认证了哪些、用户想用哪个。

真机联调立刻暴露了代价。本机 Pi 的默认模型是 `glm-5.3`，但 Pi 拒绝了这个参数：

```
Error: Model "glm-5.3" is ambiguous across providers: opencode-go/glm-5.3, opencode/glm-5.3,
qwen-token-plan-cn/glm-5.3, qwen-token-plan/glm-5.3, radius/glm-5.3, zai-coding-cn/glm-5.3, zai/glm-5.3.
More than one matching provider is authenticated. Use --provider or provider/model.
```

裸模型名在有多个 provider 已认证时**无法**被解析，而平台没有任何办法自己把 `provider/` 前缀补全——补全逻辑只能来自 agent。

## 决定

1. **模型清单只能从 agent 自己那里取。** Pi 适配器在 worker 启动时发一次 `get_available_models`（RPC 命令，见 Pi 文档 `docs/rpc-commands.md`），把 `{provider, id}` 组成 `provider/id` 作为模型字符串。取不到就报**空列表**。
2. **空 model 是合法值，意思是「用 agent 自己的默认」。** 领域层不校验 model 非空（`packages/domain/src/session.ts`），契约里 `model: z.string()` 而不是 `min(1)`。画布上显示「默认模型」。
3. **UI 不隐藏做不到的事。** 模型列表为空时，派生对话框显示「用 agent 自己的默认」并禁用选择器；能力做不到时同理（`limited(reason)` / `denied(reason)`）。
4. OpenCode 走 ACP，`session/new` 没有稳定的模型字段，所以它的 `models` 恒为 `[]`——这不是缺陷，是如实上报。

## 为什么不能改成「平台维护一份模型表」

因为那份表在每台机器上都是错的，而且错得很安静：它会让画布显示一个你根本没认证的模型，然后失败在 agent 进程里而不是在界面上。用户对「可选但不可用」的容忍度，远低于对「不提供但说清楚」的容忍度。

## 后果

- worker 启动时要多花一次 RPC 往返（约 1–2 秒）才能完成 hello。这段时间画布上的 agent 列表是空的，因此画布查询在 agent 列表为空时按 2 秒轮询：等节点上线不该变成用户要记住的手动刷新。
- 模型字符串的格式被 agent 定义（`provider/id`），平台只当不透明字符串转发。换一个 agent，格式可以完全不同。
- `PI_DEFAULT_MODEL` 可以强制覆盖，用于 Pi 的探测失败或想固定模型的场景。
- 新增 agent 时的自查项：**如果你的 descriptor 里的模型名是人写的，它就是错的**。
