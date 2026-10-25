# 0007. 可调项来自 agent，不是来自平台

Status: accepted
日期: 2026-10-25

## 背景

用户要求：会话里要能选模型、选思考强度，「参考 opencode web，不过我们这个是通用的，要能适配不同的 agent 运行时」。

这句话里有一个陷阱。「参考 opencode web」听起来是照着画一个下拉框；但真正的约束是后半句：**通用**。如果平台自己定义「模型清单」「思考档位」这两个概念，那么每接一个新 agent，就要有人在平台里补一次它的模型表和档位表——而这份表在每台机器上都是错的，而且错得很安静（ADR 0003 记的那次：`glm-5.3` 在七个 provider 下同名，选错不报错，只把账记到别人的账号上）。

调研后确认两边都有现成的、agent 自己发声的机制：

- **ACP v2 的 Session Config Options**：`session/new` 的 result 可带 `configOptions: ConfigOption[]`，每项 `{configId, name, description?, category?, type: 'select'|'boolean', currentValue, options?}`。`category` 有保留值 `mode` / `model` / `model_config` / `thought_level`，规范明确写着**它只用于摆放，客户端不得依赖它做正确性判断**。改值走 `session/set_config_option`，响应是**全量**新状态（换模型会连带改变 reasoning 档位的可选值）。agent 也能用 `session/update` 的 `config_option_update` 主动推全量状态——比如限流后自己降级换模型。
- **Pi 的自有 RPC**：`get_available_models` / `set_model{provider, modelId}`、`get_available_thinking_levels` / `set_thinking_level{level}`、`get_state`（带此刻真在用的 `thinkingLevel`）。

也就是说：两个 agent 都用不同的方式说着同一件事——「我能被调的东西是这些，当前是这些」。

## 决定

1. 领域里加一个概念 `RuntimeOption`（`id`、`label`、`category`、`kind: 'select'|'boolean'`、`current`、`choices`），把它当作**搬运的形状**，不是解释的对象。`category` 只影响摆放，不影响任何判断。
2. `AgentRuntime` 的会话要能自报清单：`options()` 与 `changeOption(id, value)`。ACP 直接转手 `configOptions`；Pi 用两条 RPC 拼出来。
3. 会话持久化两份：`options`（当前值映射）与 `optionSpec`（整份清单）。只存值不够——选择器要列候选，而候选只有 agent 知道，且换模型后候选会变。
4. 落库只认 agent 的回报。用户点选之后，平台**不**把选中的值当成「新的当前值」写进库，而是等 agent 回报全量状态再写。因为「换模型成功了」这件事，只有换完之后还愿意回答的 agent 有资格说。
5. UI 一行硬编码的选项名都没有：agent 报几条画几条，未认识的 category 归到「其它」照画。

## 后果

好的：

- 接一个新 ACP agent，可调项是零成本的（它自己会报）；接一个非 ACP agent，成本也就是两条 RPC。
- 「换模型」这条路径上不需要平台维护任何模型表，ADR 0003 的纪律自动延续到所有选项。
- agent 主动降级换模型（ACP 的 `config_option_update`）能被如实显示，而不是让界面和真实状态分叉。

代价：

- 改一次选项要一次往返，`POST /api/sessions/:id/options` 会等 agent 回报（上限 8 秒），比「直接回显」慢。
- 会话被托管之后才能改选项。跑完的会话已经不在了，所以改选项前要按上次的位置重新拉起 agent——和「接着说一句」是同一条路径。
- 清单形状由 agent 定义，平台没法保证两个 agent 的选项长得像。这是故意的：假装统一，就得有人替它们翻译，而翻译表总会过期。

## 没选的方案

**平台维护一张模型表，把 agent 的选项映射过来。** 不选：这张表在每台机器上都是错的，而且错得安静（ADR 0003 已经为此付过一次账）。

**把模型做成 `Session.model` 这一列的投影，不再单独有可调项。** 不选：思考强度、模式、以及将来任何 agent 自己想暴露的旋钮，都会被迫再加一列。`Session.model` 保留是因为重开 agent 时要给 Pi 传 `--model`，它是「重启参数」，不是「选项系统的真相」。

**让 UI 自己查 agent 的能力再决定显示什么下拉框。** 不选：那等于在客户端里硬编码「Pi 有思考强度、OpenCode 没有」。UI 只问一件事：「这条会话的 agent 报了哪些选项？」
