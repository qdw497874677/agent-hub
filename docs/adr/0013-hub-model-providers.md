# ADR 0013：hub 统一配置模型提供商（草案）

- 状态：**proposed**（草案，未实现，待 David 拍板 `docs/design/model-providers.md` §8）
- 日期：2026-10-30

## 背景
团队希望 agent 用 hub 统一配置的模型提供商（OpenAI / Anthropic 兼容网关，如 cliproxy），而不是每台 worker 各自登录、各自写配置。ADR 0003 规定模型清单来自 agent；本 ADR 在其上增加「hub 下发的提供商」。

## 决定（提议）
1. 新聚合 `ModelProvider`（team 或 hub 级），密钥存 `SecretVault`（静态加密），provider 表只存引用；权限 `provider.read/use/manage`（ADR 0011）。
2. 会话开始时 server 解析该会话可用的提供商，把明文 key 随 session-start 帧下发；worker 只放进 agent 子进程 env，渲染出的文件只含变量引用；不持久化，resume 时重新下发。
3. 每个 runtime 用自己的**每进程**机制渲染（均已实测，全局配置零改动）：Pi = `-e` 会话扩展 `registerProvider`；OpenCode = `OPENCODE_CONFIG_CONTENT`（v1 `provider` / v2 `providers` 方言）；Grok = 每会话私有 `GROK_HOME/config.toml`（`GROK_CONFIG` 覆盖层不接受 `model.*`）。
4. hub 提供商一律在 `hub-<slug>` 命名空间，与原生模型并列显示，不覆盖原生配置；未选 hub 模型时行为与今天完全一致。
5. 渲染能力挂在新的统一端口 `RuntimeAdapter.providers`（`docs/design/runtime-adapter-contract.md`）上，由 conformance 套件检查「密钥不进 argv / 文件 / 日志、不写全局配置」。

## 后果
- 正面：集中管理、轮换、审计；新 worker 无需各自配 key。
- 负面：v1 的 key 在 agent 进程 env 中，agent 的工具子进程可读（v2 用本机 relay 消除）；Grok 走私有 GROK_HOME，看不到本机规则/插件，且 GROK_HOME 需随会话保留；OpenCode v2 的 env 覆盖属上游「兼容待恢复」区域，需要版本门与集成测试。

## 备选（已否决）
- 改写各 agent 全局配置：违反「不碰 worker 全局配置」，多会话竞争。
- `pi --api-key` / 命令行传 key：`ps` 可见。
- `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME` 换目录：前者连凭据和会话一起换走，后者在 OpenCode v2 上实测无效。
