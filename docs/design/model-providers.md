# Hub 统一配置的模型提供商（Model Providers）

> 状态：设计草案（未实现）· 2026-10-30 · 关联：ADR 0013（草案）、ADR 0003/0007/0010/0011、`runtime-adapter-contract.md`
> 一句话：**能做，三家（Pi 1.4.0、OpenCode 1.19.4 与 v2.2.2、Grok 1.0.70）都已在本机实测「每进程注入一个 OpenAI 兼容提供商 → 模型清单出现 → 真实回复 HUB-OK」，且全局配置零改动。** Grok 支持自定义提供商，但只能靠「每会话私有 GROK_HOME」注入，代价最大。

## 1. 结论与每个 runtime 的注入机制（实测）

| runtime | 自定义提供商能力 | 选定的每进程注入方式 | 密钥怎么进 | 失败 / 不选的方式 |
|---|---|---|---|---|
| **Pi 1.4.0** | `models.json` 或扩展 `pi.registerProvider()`；api：`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`；支持 `refreshModels` 动态发现 | **`-e <会话私有>/hub-providers.ts`**（扩展里 `registerProvider("hub-<slug>", {baseUrl, apiKey:"$HUB_PROVIDER_<N>_KEY", api, models})`）+ `--model hub-<slug>/<id>` | 子进程 env；扩展文件里只有 `$VAR` 引用 | `PI_CODING_AGENT_DIR` 换目录：会连 auth.json/settings/会话一起换掉 ✗；`--api-key`：进 argv，`ps` 可见 ✗；改 `~/.pi/agent/models.json`：全局 ✗ |
| **OpenCode 1.19.4**（现装，v1 方言） | `provider.<id>`：`npm:"@ai-sdk/openai-compatible"`、`options.baseURL`、`options.apiKey:"{env:VAR}"`、`models` | **`OPENCODE_CONFIG_CONTENT`**（已用于资产，深合并即可） | env + `{env:VAR}` 引用 | `OPENCODE_CONFIG`（文件）也可用；issue #34638 说 ACP 忽略 CONTENT——**在 1.19.4 上不复现** |
| **OpenCode v2.2.2**（`opencode-ai@dev`，二进制 `opencode2`） | `providers.<id>`：`package:"@opencode/ai/providers/openai-compatible"`（另有 `anthropic-compatible`、`openai-compatible/responses` 等）、`settings.baseURL`、`env:[VAR]`、`models` | **`OPENCODE_CONFIG_CONTENT`**（ACP 与 `run` 都实测可用），备选 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` | env（`env:["HUB_PROVIDER_<N>_KEY"]`） | `XDG_CONFIG_HOME` 指向临时目录：**不生效**（Model unavailable）；`acp --standalone`：不支持；issue #36990 称 v2 忽略 CONTENT——在 2.2.2 上不成立，但属于上游声明「兼容待恢复」的区域，需版本门 |
| **Grok 1.0.70** | **支持**：`[model.<id>]` 的 `base_url`、`env_key`、`api_backend = chat_completions / responses / messages`、`[model_providers.<id>]` 共享块 | **每会话私有 `GROK_HOME`**，里面写 `config.toml`（只含 `env_key` 名） | env（`env_key = "HUB_PROVIDER_<N>_KEY"`） | `GROK_CONFIG` / `GROK_CONFIG_PATH` 覆盖层：**白名单只收 `models/features/toolset/…`，`model.*` 表被丢弃**（实测不出现）；改 `~/.grok/config.toml`：全局 ✗ |

Grok 的诚实说明：
- 不需要 `grok login`、也不需要 `XAI_API_KEY`（实测两者都没有时，ACP `grok agent stdio` 照样列出并回复）。
- 代价：`GROK_HOME` 同时装着会话记录、日志、插件、规则、登录态。私有 GROK_HOME ⇒ 这个会话看不到用户的 `~/.grok` 规则/插件/登录模型；**恢复（session/load）必须复用同一个 GROK_HOME**，所以它不能放 tmpfs 随用随删，要跟会话同寿命。
- 另有 `--xai-api-base-url` / `GROK_XAI_API_BASE_URL`：只能把「xAI 线协议」整体改道（比如 hub 自建网关），不是多提供商方案，作为后备记录。

## 2. 领域模型（hub 侧）

```ts
// packages/domain/src/model-provider.ts（新聚合）
interface ModelProvider {
  id: ProviderId;
  teamId: TeamId | null;          // null = 全 hub（只有 hub 管理员能建）
  slug: string;                   // 'cliproxy' → 运行时里的提供商 id 'hub-cliproxy'
  name: string;
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  baseUrl: string;                // https，或管理员显式允许的内网地址
  secretRef: string;              // SecretVault 里的名字，如 'provider/<id>/key'；值从不离开 vault
  headers?: Record<string, string /* 允许 ${secret:NAME} */>;
  models: ProviderModel[];        // {id, name?, contextWindow?, maxTokens?, reasoning?, input?}
  discovery: 'manual' | 'auto';   // auto = 定时/手动拉 GET {baseUrl}/models
  allowedModels?: string[];       // auto 时的白名单（glob）
  enabled: boolean;
  lastCheck?: { at: number; ok: boolean; latencyMs?: number; error?: string /* 已脱敏 */ };
  createdBy: UserId; updatedAt: number; keyRotatedAt: number;
}
interface ProviderAssignment { providerId; scope: 'team' | 'project' | 'worker'; targetId; }
```

- **静态加密**：复用现有 `SecretVault`（`storage-sqlite/secrets.ts`，主密钥 `HUB_SECRET_KEY` 或 `secret.key`，AES-GCM）。provider 表只存 `secretRef`。
- **RBAC（ADR 0011）**新增权限：`provider.read`（看名字/模型，不看密钥）、`provider.use`（会话里能选）、`provider.manage`（增删改、轮换、测试）。默认：team owner/admin = manage；member = read+use；viewer = read；hub 管理员 `hub.*` 可建 hub 级提供商。
- **分配**：provider 先属于 team（或 hub）；可再限制到 project / worker。会话可用集合 = `visible(principal)` ∩ 分配到 (project ∪ team) ∩（若 provider 限定 worker）该会话所在 worker ∩ runtime 支持的 protocol。

## 3. 模型选择器

- worker 上报的原生模型（ADR 0003，`provider/id`）+ hub 提供商模型 `hub-<slug>/<id>`，分组显示：「Hub · cliproxy」「本机 · Pi 原生」。
- `hub-` 前缀是保留命名空间：不会和原生 `openai/…` 撞车，原生配置一个字都不动；hub 渲染时也跳过已存在的同名 id 并告警。
- 不支持该 protocol 的 runtime 置灰并给原因（能力矩阵新增 `hub_providers` 能力：pi/opencode `available`，grok `limited: 私有 GROK_HOME，看不到本机规则/插件`）。
- 选了 hub 模型 ⇒ `StartSpec.options.model = 'hub-cliproxy/grok-3-mini-fast'` + `StartSpec.providers = [grant]`；中途换到另一个 hub 提供商要求它在开会话时已下发（v1：开会话时下发「该会话可用的全部 hub 提供商」，见待决 D3）。

## 4. 下发协议与密钥生命周期

```ts
interface ProviderGrant {          // server → worker，随 session-start 帧
  slug: string; protocol; baseUrl; headers?; models: ProviderModel[];
  envName: string;                 // 'HUB_PROVIDER_1_KEY'
  secret: string;                  // 明文，只在这一帧、只在内存
}
```
1. server 在 `sessions.start` 用例里按 §2 解析可用集合 → `SecretVault.reveal()` → 组帧，**只走已认证的 worker 长连接（TLS）**；审计记 `provider.use`（谁、哪个会话、哪个 provider、哪台 worker，不记值）。
2. worker：`adapter.providers.render(grants)` → `LaunchPlan`：
   - `env[envName] = secret`（唯一出现明文的地方）；
   - 私有文件（Pi 扩展 / Grok config.toml / 可选 OpenCode 配置文件）只写 `$VAR` / `{env:}` / `env_key` 引用——**conformance 断言文件内容不含密钥**；
   - argv 不含密钥。
3. 进程退出 / `dispose` ⇒ 清理私有目录（Grok 例外：保留到会话删除，因为恢复需要）。
4. **恢复/重启**：worker 不持久化密钥；会话 resume 时 server 重新下发 grant（顺带实现轮换生效）。
5. 日志：`LaunchPlan.redacted()` 只列 env 键名；ACP/RPC 原始流不落日志；错误信息过脱敏器（把已知 secret 值替换为 `***`）。

### 落盘取舍
| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 只进 env（推荐，三家都可行） | 不落盘 | 同 uid 进程可读 `/proc/<pid>/environ`；agent 的 bash 工具子进程会继承 env ⇒ **agent 自己能 `echo $HUB_PROVIDER_1_KEY`** |
| B. 私有目录在 tmpfs（`$XDG_RUNTIME_DIR` 或 `/dev/shm`，0700） | 文件不进磁盘 | 只适合不含密钥的渲染文件；Grok 的 GROK_HOME 要跨重启保留，不能放 tmpfs |
| C. 本机 relay（worker 起 `127.0.0.1:随机端口` 反代，agent 只拿一次性会话 token） | 真密钥从不进 agent 进程；可按会话计量、限速、吊销 | 要实现流式反代（SSE），多一跳；Pi/OpenCode/Grok 都只需把 baseUrl 指向 relay，适配层不变 |

建议 v1 = A + B，并对 agent 工具子进程**剥离** `HUB_PROVIDER_*`：Grok 有 `[shell_environment_policy]` 可配（覆盖层白名单允许），Pi/OpenCode 暂无同等开关 ⇒ 风险明示；v2 = C（与已有 MCP relay 同一模式，见 `mcp-relay.ts`）。待决 D1。

## 5. 各 runtime 的 ProviderRenderer

**Pi**（protocol → api：openai-chat→`openai-completions`，openai-responses→`openai-responses`，anthropic-messages→`anthropic-messages`）
```ts
// <session-dir>/hub-providers.ts（生成，无密钥）
export default function (pi) {
  pi.registerProvider('hub-cliproxy', { name: 'Hub · cliproxy', baseUrl: 'https://…/v1',
    apiKey: '$HUB_PROVIDER_1_KEY', api: 'openai-completions', models: [/* … */] });
}
```
args 追加 `-e <path>`；模型走现有 `--model`。与现有 MCP 注入一样经 `piAssetArgs` 拼装。

**OpenCode**：按 `opencode --version` 选方言，深合并进现有 `OPENCODE_CONFIG_CONTENT`（`mergeConfig`，用户的值优先，所以 `hub-` 命名空间必须不冲突）。
- v1：`{"provider":{"hub-cliproxy":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"…","apiKey":"{env:HUB_PROVIDER_1_KEY}"},"models":{"grok-3-mini-fast":{}}}}}`；anthropic → `@ai-sdk/anthropic` + `options.baseURL`。
- v2：`{"providers":{"hub-cliproxy":{"env":["HUB_PROVIDER_1_KEY"],"package":"@opencode/ai/providers/openai-compatible","settings":{"baseURL":"…"},"models":{…}}}}`；anthropic → `anthropic-compatible`，responses → `openai-compatible/responses`。
- 注意 v2 的 `policies`（`provider.use` deny）可被用户/系统配置阻断，渲染后用 ACP `session/new` 的模型清单自检，缺了就报「被本机策略禁用」。

**Grok**：每会话 `GROK_HOME=<worker-state>/grok-homes/<sessionId>`（0700），写
```toml
[cli]
auto_update = false
[model_providers.hub-cliproxy]
base_url = "https://…/v1"
api_backend = "chat_completions"   # responses / messages
[model.hub-cliproxy--grok-3-mini-fast]
model = "grok-3-mini-fast"
model_provider = "hub-cliproxy"
env_key = "HUB_PROVIDER_1_KEY"
```
只在会话选了 hub 模型时才用私有 GROK_HOME（否则沿用用户的，行为不变）。Grok 模型 id 没有 `/` 层级，用 `hub-<slug>--<id>` 编码。Anthropic 需要 `x-api-key`：用 `env_http_headers = {"x-api-key" = "HUB_PROVIDER_1_KEY"}`（不把值写盘）。

## 6. 可用性检查、发现、轮换、审计

- **测试连接**（`POST /api/providers/:id/test`，`provider.manage`）：**由 server 发起**，`GET {baseUrl}/models`（openai）或一次 1-token 的 messages 调用（anthropic），10s 超时，记录 latency 与脱敏错误到 `lastCheck`。可选「从某 worker 测」（worker 出网与 hub 不同，例如 tailnet 地址）——待决 D4。
- **自动发现**：`discovery:'auto'` 时同一接口拉模型，经 `allowedModels` 过滤后写入 `models`；默认手动刷新，不定时（避免费用/限流）。
- **轮换**：`PUT /api/providers/:id/key` 只写 vault，`keyRotatedAt` 更新；已在跑的会话用旧 key 直到结束或 resume（重新下发）；提供「强制重启相关会话」按钮为后续项。
- **审计动作**：`provider.create / update / delete / rotate / test / use`，带 IP 与 team（ADR 0011）；值永不入审计。

## 7. 与 agent 原生配置的共存与优先级

1. hub 只**新增** `hub-*` 命名空间的提供商，不覆盖、不读取 agent 原生凭据（`~/.pi/agent/auth.json`、OpenCode auth、`grok login`）。
2. 优先级：会话显式选择 > 项目默认 hub 模型（可选设置）> `PI_DEFAULT_MODEL` 等 worker 设置 > agent 自己的默认（ADR 0003「空 = agent 默认」不变）。
3. 用户本机配置里若已有同名 `hub-*`：渲染跳过并告警，不覆盖。
4. 团队可选「只允许 hub 提供商」（禁原生模型）——依赖各 runtime 是否能禁用原生：OpenCode v2 有 `policies`、Grok 有 `allowed_models`、Pi 有 `--models` 过滤；作为待决 D5，不进 v1。

## 8. 待 David 决定

- **D1 密钥形态**：v1 env 注入（agent 的工具子进程能读到 key）还是直接上本机 relay（key 不进 agent）？建议：v1 env + 告知，v2 relay。
- **D2 作用域**：提供商只允许 team 级 + hub 级？是否需要「个人提供商」（用户自带 key）？
- **D3 会话内切换**：开会话时下发该会话可用的**全部** hub 提供商（可中途切），还是只下发选中的那一个（最小暴露，换提供商需重启会话）？建议后者。
- **D4 测试连接从哪发**：server 还是指定 worker（两者网络可能不同，cliproxy 是 tailnet 地址）？
- **D5 是否支持「禁用原生模型」策略**（v1 不做）。
- **D6 Grok**：接受「选 hub 模型时会话看不到本机 Grok 规则/插件、GROK_HOME 跟会话同寿命」这一代价？或者 Grok 先不开放 hub 提供商。
- **D7 OpenCode v2**：现在 worker 装的是 1.19.4；v2 仍是 dev/beta 标签。是否现在就为 v2 方言写渲染（实测可用），还是等 v2 进 latest？
- **D8 是否先做 runtime-adapter-contract 的 M1–M4 重构再做提供商**（建议是：提供商作为契约的第一个新能力落地）。

## 附录 A：实测记录（2026-10-30 10:50–11:10 PDT，本机）

测试提供商：cliproxy（OpenAI 兼容，key 从 `~/.config/agent-hub/cliproxy.env` 读入进程环境，**未打印、未写入任何渲染文件**），模型 `grok-3-mini-fast`，提示 `Reply with exactly: HUB-OK`。
全局配置哨兵：`~/.pi/agent/models.json`、`~/.pi/agent/settings.json`、`~/.config/opencode/opencode.json`、`~/.grok/config.toml` 实验前后 sha256 **全部不变**。

| # | runtime / 方式 | 模型清单 | 回复 |
|---|---|---|---|
| 1 | Pi 1.4.0 `pi -e hub.ts --list-models` | `hub-cliproxy grok-3-mini-fast` ✓ | — |
| 2 | Pi `-e hub.ts -p … --model hub-cliproxy/grok-3-mini-fast` | — | `HUB-OK` ✓ |
| 3 | Pi `--mode rpc -e hub.ts`（hub 实际用的模式） | `get_available_models` 含 hub-cliproxy ✓ | `HUB-OK` ✓ |
| 4 | OpenCode 1.19.4 `opencode acp` + `OPENCODE_CONFIG_CONTENT`（v1 方言） | `session/new` 含 ✓ | `HUB-OK` ✓ |
| 5 | OpenCode 1.19.4 `opencode acp` + `OPENCODE_CONFIG` | ✓ | （未单测回复） |
| 6 | OpenCode v2.2.2 `run --standalone` + CONTENT / CONFIG / CONFIG_DIR / cwd `opencode.json` | ✓ ✓ ✓ ✓ | `HUB-OK` ×4 ✓ |
| 7 | OpenCode v2.2.2 `run --standalone` + 临时 `XDG_CONFIG_HOME` | ✗ | `Model unavailable` ✗ |
| 8 | OpenCode v2.2.2 `opencode2 acp` + CONTENT / CONFIG | ✓ ✓ | `HUB-OK` ×2 ✓ |
| 9 | OpenCode v2.2.2 同 HOME 第二个进程不带配置 | ✗（未泄漏到别的进程）✓ | — |
| 10 | OpenCode v2.2.2 `acp --standalone` | ✗（不支持该用法） | ✗ |
| 11 | Grok 1.0.70 私有 `GROK_HOME` + `grok models` | `hub-cliproxy` ✓ | — |
| 12 | Grok 私有 `GROK_HOME` + `grok -p … -m hub-cliproxy`（无 XAI_API_KEY、无登录） | — | `HUB-OK` ✓ |
| 13 | Grok 私有 `GROK_HOME` + `grok agent stdio`（ACP） | ✓ | `HUB-OK` ✓ |
| 14 | Grok `GROK_CONFIG` / `GROK_CONFIG_PATH` 带 `model.*` | ✗（白名单丢弃） | — |

OpenCode v2 安装在隔离前缀 `/tmp/oc2`（`npm i --prefix`，未动全局 npm），所有 v2 实验都用临时 HOME；v2 会自己拉起后台 `serve --service` 进程，实验后已结束。v2 的 ACP 在默认（非 standalone）模式下仍按调用进程的 env 生效且不串到别的进程（#8/#9），但这是后台服务模型——上线前 conformance 集成档要固定版本复测。
