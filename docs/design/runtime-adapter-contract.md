# 统一运行时适配器契约（Runtime Adapter Contract）

> 状态：设计草案（未实现）· 2026-10-30 · 关联：ADR 0013、`model-providers.md`
> 目标：**新增一个 agent = 实现一个模块**（一个 `RuntimeAdapter` 对象 + 一份 conformance fixture），组合根（worker `main.ts`）只做一行注册。

## 1. 现状盘点：一个 runtime 今天散落在哪些地方

| 关注点 | 现在的位置 | Pi | OpenCode（ACP） | Grok |
|---|---|---|---|---|
| 描述 / 能力矩阵 | `domain/agent.ts` `AgentDescriptor` + 各包 `descriptor.ts` | `adapters/pi/descriptor.ts` | `acp/config.ts` `acpDescriptor()` | `grok/descriptor.ts` |
| 会话端口 | `domain/ports/agent-runtime.ts` `AgentRuntime.start()` → `RuntimeSession`（prompt/interrupt/events/adopt/options/changeOption/dispose） | `pi-runtime.ts`（RPC） | `acp-runtime.ts`（通用 ACP） | `grok-runtime.ts`（ACP 配置 + 认证钩子） |
| 就绪探测 | `ports/harness-readiness.ts` | `pi/readiness.ts` | `acp/readiness.ts` | `grok/readiness.ts` |
| 命令解析 | **worker `main.ts`** `harnessCommand()` + `PI_COMMAND`/`GROK_COMMAND`/`OPENCODE_COMMAND` 特判 | main.ts | main.ts（按 id 推 `X_COMMAND`） | main.ts |
| 安装 / 卸载 | `ports/harness-installer.ts`（ADR 0010） | `pi/installer.ts` | `acp/installer.ts`（写死 opencode） | `grok/installer.ts` |
| 模型清单 | ADR 0003；各包 `discover-models.ts`，**在 main.ts 启动时手工调用** | RPC `get_available_models` | `opencode models` | `grok models` |
| 可调项（options） | ADR 0007；`RuntimeSession.options()/changeOption()` | `map-*` | `acp/map-options.ts` | 同 ACP |
| 事件映射 | 各包 `map-event.ts` / `acp/map-acp.ts` + `conformance.test.ts`（fixture） | `map-event.ts` | `map-acp.ts` | 复用 ACP |
| 产出物 | 从 `tool_result` 事件推导（map-event 内） | 记住 write 的 path | ACP 工具调用 | 同 ACP |
| 恢复 / 分叉 | `StartSpec.resume`、ADR 0012（只从最新处分叉，能力 `limited`） | `--session-id` | `session/load` | `session/load` / `--fork-session` |
| 技能 / 指令（资产） | `StartSpec.assets` → 各自启动参数 | `piAssetArgs` | `opencodeLaunch` → `OPENCODE_CONFIG_CONTENT` | `sessionMeta.rules` |
| MCP 工具 | `StartSpec.tools/mcp` | **改写用户全局 Pi mcp.json**（只放变量引用）+ env | `session/new.mcpServers` | 同 ACP |
| ACP 额外定制 | `AcpAgentConfig.launch/authenticate/sessionMeta/listModelsArgs` | — | config | config |
| （新）模型提供商渲染 | 无 | — | — | — |

问题：
1. **组合根知道每个 runtime 的细节**：main.ts 里 `const pi = harnessCommand('pi','PI_COMMAND')`、`discoverPiModels(...)`、`if (config.id !== 'opencode')`、installers 列表、readiness 列表——加一个 agent 要改 5 处。
2. 端口拆成 3 个互不关联的对象（`AgentRuntime` / `HarnessReadiness` / `HarnessInstaller`），靠 `agentId` 字符串对齐，没有类型保证。
3. 启动期注入（资产、MCP、将来的模型提供商）每家各写一套，没有统一的「渲染启动计划」步骤，密钥在哪一步出现不可审查。
4. conformance 只测事件映射，不测启动注入、不测「不碰全局配置」。

## 2. 提案：一个端口 `RuntimeAdapter`

```ts
// packages/domain/src/ports/runtime-adapter.ts（新）
export interface RuntimeAdapter {
  readonly id: AgentId;                 // 'pi' | 'opencode' | 'grok' | …
  readonly label: string;
  /** 命令名 + 覆盖它的环境变量名（PI_COMMAND…）：组合根统一解析，不再特判。 */
  readonly command: { readonly name: string; readonly envVar: string };
  readonly capabilities: CapabilityMatrix;

  /** 便宜、无副作用：装了吗、能用吗、本机原生模型清单（合并原 readiness + discover-models）。 */
  probe(ctx: ProbeContext): Promise<HarnessProbe>;

  /** 把一次会话要的一切翻译成「怎么拉起进程」——纯函数式，可单测，密钥只出现在 env。 */
  plan(spec: StartSpec, ctx: PlanContext): Promise<Result<LaunchPlan, DomainError>>;

  /** 按 plan 拉起并返回会话（RPC / ACP 的传输细节在这里）。 */
  start(plan: LaunchPlan, spec: StartSpec): Promise<Result<RuntimeSession, DomainError>>;

  // —— 可选，按能力开启 ——
  readonly installer?: HarnessInstaller;                       // ADR 0010；缺 = 「只能用机器自带的」
  readonly providers?: ProviderRenderer;                       // model-providers.md；缺 = 不支持 hub 提供商
  readonly fork?: (src: AgentSessionRef, spec: StartSpec) => Promise<Result<RuntimeSession, DomainError>>; // 缺 = fork denied
}

export interface LaunchPlan {
  readonly command: string;
  readonly args: readonly string[];          // 不得含密钥（ps 可见）
  readonly env: Readonly<Record<string, string>>; // 唯一允许出现明文密钥的地方
  readonly cwd: string;
  readonly files: readonly PlannedFile[];    // 每会话私有目录里要写的文件（不得含明文密钥，conformance 检查）
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly cleanup: 'on-dispose' | 'keep-for-resume';
  /** 给日志看的脱敏视图（env 只列键名）。 */
  redacted(): string;
}

export interface ProviderRenderer {
  /** 这个 runtime 认得哪些线协议：'openai-chat' | 'openai-responses' | 'anthropic-messages' … */
  readonly protocols: readonly ProviderProtocol[];
  /** 把 hub 下发的 ProviderGrant[] 渲染成 env + 私有文件片段 + 额外参数，合并进 LaunchPlan。 */
  render(grants: readonly ProviderGrant[], ctx: PlanContext): ProviderRendering;
}
```

`StartSpec` 只加一个字段：`providers?: readonly ProviderGrant[]`（见 model-providers.md §4）。`RuntimeSession` 不变。

**`plan()` / `start()` 拆开的理由**：所有注入（资产、MCP、提供商、认证）都变成对 `LaunchPlan` 的纯变换——可以对着快照单测、可以统一脱敏打日志、可以统一做「不碰全局配置 / 不把密钥写盘 / 不进 argv」的检查。传输层（Pi RPC、ACP）只管把 plan 跑起来。

### 共享积木（不是每家重写）
- `acpTransport(config)`：现在的 `createAcpRuntime` 变成积木；OpenCode、Grok、Claude-code 等 ACP agent 的 adapter = `acpTransport` + 自己的 `plan` 变换。
- `ACP_AGENTS` 环境变量里的「纯配置」agent 仍然支持：`genericAcpAdapter(config)` 生成一个没有 `providers` / `installer` 的 adapter。
- `planHelpers`：会话私有目录（`<worker-state>/sessions/<sessionId>/`，0700）、tmpfs 选择、env 合并、`OPENCODE_CONFIG_CONTENT` 深合并（现有 `mergeConfig`）。

## 3. 注册表

```ts
// apps/worker/src/runtimes.ts
export const RUNTIME_ADAPTERS: readonly RuntimeAdapter[] = [piAdapter(), opencodeAdapter(), grokAdapter(), ...acpAgentsFromEnv()];
```
组合根循环一次：解析命令（`command.name/envVar`，统一走 `resolveCommand` + runtime store shim）→ `probe` → 汇总 readiness/models 上报 → 收集 `installer` → 会话来时按 id 取 adapter 走 `plan → start`。web 端已经只按 `agentId` + 能力矩阵渲染（`harness.tsx`、`dialogs.tsx` 无名字特判），不用改；server 侧 `runtime-install.ts` 只透传 agentId。

## 4. Conformance 套件（每个 adapter 必须过）

`packages/domain/src/testing/runtime-conformance.ts` 导出 `runRuntimeConformance(adapter, fixtures)`：
1. **事件映射**：录制的原始记录 → 归一化事件（现有 conformance.test.ts 收编进来）。
2. **描述一致性**：`descriptor.models` 与 options 里 `category:'model'` 一致（ADR 0003/0007）。
3. **plan 安全**：给一份带假密钥 `sk-CONFORMANCE-xxxx` 的 spec：
   - argv、`files[*].content`、`redacted()` 里都**不得出现**该字符串；只能出现在 `env`；
   - `files` 只能落在会话私有目录下；不得写 `$HOME/.pi`、`~/.config/opencode`、`~/.grok`。
4. **全局配置不变**（集成档，可选跑真二进制）：临时 HOME 里放哨兵全局配置，跑 plan+start+dispose，前后 sha256 相同。
5. **提供商冒烟**（集成档，需要 `CONFORMANCE_PROVIDER_BASE_URL/KEY`）：注入一个 openai 兼容提供商 → 模型清单出现 `hub-<slug>/<model>` → 发 `Reply with exactly: HUB-OK` 收到回复。§ model-providers.md 附录 A 的手工实验就是这一档的原型。
6. **能力门**：声明 `fork: denied` 的不得提供 `fork()`；没有 `providers` 的 adapter，hub 下发 grants 时必须返回明确错误而不是静默忽略。

## 5. 迁移计划（每步可独立合并、行为不变）

1. **M1 加端口不改行为**：新增 `RuntimeAdapter`、`LaunchPlan`、conformance 骨架；写 `legacyAdapter(runtime, readiness, installer)` 把现有三件套包起来。main.ts 改为注册表循环。
2. **M2 Pi**：把 `pi-runtime.ts` 里拼 args/env 的部分抽成 `piPlan()`；**同时把 MCP 注入从「改写用户全局 mcp.json」挪到 `-e` 会话扩展或私有文件**（这是现存的唯一一处全局写，和新契约冲突）。
3. **M3 ACP/OpenCode**：`opencodeLaunch` → `opencodePlan()`；`createAcpRuntime` → `acpTransport`；installer 从 acp 包挪进 opencode adapter。识别 OpenCode v1/v2（`--version` 前缀）以决定 `provider` 还是 `providers` 方言。
4. **M4 Grok**：`grokAcpConfig` → `grokAdapter`（acpTransport + grokPlan）；认证钩子进 plan。
5. **M5 提供商**：给三家加 `ProviderRenderer`（model-providers.md）。
6. **M6 清理**：删除 main.ts 中所有按名字的分支与 `discover*Models` 直接调用；README「新增 agent」改为「实现 RuntimeAdapter + fixture」。
