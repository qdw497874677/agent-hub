# ADR 0013：hub 统一配置模型提供商

- 状态：**accepted**（2026-10-30，David 拍板，见 `docs/design/model-providers.md` §8）
- 日期：2026-10-30

## 背景
团队希望 agent 用 hub 统一配置的模型提供商（OpenAI / Anthropic 兼容网关，如 cliproxy），而不是每台 worker 各自登录、各自写配置。ADR 0003 规定模型清单来自 agent；本 ADR 在其上增加「hub 下发的提供商」。

## 决定（提议）
1. 新聚合 `ModelProvider`（个人 / team / hub 三级，D2：用户可自带 key 只给自己用），密钥存 `SecretVault`（静态加密），provider 表只存引用；权限 `provider.read/use/manage`（ADR 0011）。
2. 会话开始时 server 只下发**会话选中的那一个**提供商（D3；换提供商 = 重启会话），明文 key 随 session-start 帧到 worker 内存。**worker 起本机中转（只绑 127.0.0.1、每会话随机 token），由中转注入真 key**；agent 进程只拿到中转 URL + 会话 token，真 key 永不进 agent 的 env / argv / 文件 / 日志（D1）。不持久化，resume 时重新下发。
3. 每个 runtime 用自己的**每进程**机制渲染（均已实测，全局配置零改动）：Pi = `-e` 会话扩展 `registerProvider`；OpenCode = `OPENCODE_CONFIG_CONTENT`（v1 `provider` / v2 `providers` 方言）；Grok = 每会话私有 `GROK_HOME/config.toml`（`GROK_CONFIG` 覆盖层不接受 `model.*`；接受看不到本机规则/插件的代价，D6）。OpenCode 以 v2 `providers` 方言为准，v1 只在零成本时保留（D7）。
6. 测试连接从 worker 发起（D4）；v1 不做「禁用原生模型」（D5）。
7. 顺序：先做统一 `RuntimeAdapter` 契约重构（M1–M4，行为不变 + conformance 套件），再做提供商（D8）。
4. hub 提供商一律在 `hub-<slug>` 命名空间，与原生模型并列显示，不覆盖原生配置；未选 hub 模型时行为与今天完全一致。
5. 渲染能力挂在新的统一端口 `RuntimeAdapter.providers`（`docs/design/runtime-adapter-contract.md`）上，由 conformance 套件检查「密钥不进 argv / 文件 / 日志、不写全局配置」。

## 后果
- 正面：集中管理、轮换、审计；新 worker 无需各自配 key。
- 负面：worker 要多跑一个流式中转（SSE 透传）；Grok 走私有 GROK_HOME，看不到本机规则/插件，且 GROK_HOME 需随会话保留；OpenCode v2 的 env 覆盖属上游「兼容待恢复」区域，需要版本门与集成测试。

## 备选（已否决）
- 改写各 agent 全局配置：违反「不碰 worker 全局配置」，多会话竞争。
- `pi --api-key` / 命令行传 key：`ps` 可见。
- `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME` 换目录：前者连凭据和会话一起换走，后者在 OpenCode v2 上实测无效。
