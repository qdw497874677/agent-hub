# 模型提供商（使用说明）

设计见 `docs/design/model-providers.md`，决定见 `docs/adr/0013-hub-model-providers.md`。

## 配一个
右上角账号菜单 →「模型提供商」→「添加模型提供商」：

| 字段 | 说明 |
| --- | --- |
| 名称 / 标识 | 标识进模型 id：`hub-<标识>/<模型>`，建好后不能改 |
| 作用域 | 个人（只有自己，且只能用在自己所在团队的项目）· 团队（团队主人建，本团队项目可用）· 全站（hub 管理员建，所有人可用） |
| 协议 | OpenAI Chat Completions / OpenAI Responses / Anthropic Messages |
| Base URL | 例如 `https://api.example.com/v1`；不许带账号密码 |
| API Key | 只写不读，静态加密存库 |
| 模型 id | 一行一个 |
| 请求怎么走 | worker 直连（默认）或经 hub 中转（密钥不离开 hub，worker 要能连到 hub） |

「测试连接」从选中的那台 worker 发起（直连：worker→提供商；中转：worker→hub→提供商），请求 `GET <Base URL>/models`。

按 worker 覆盖路由：`PUT /api/providers/routing/<workerId>`，`{"routing":"hub"|"direct"|null}`（null = 用提供商自己的设置）。

## 用
开会话时模型列表里会出现 `hub-<标识>/<模型>`（只在那台机器的 agent 认得该协议时出现：Pi、OpenCode、Grok）。

- 一次会话只下发选中的那一个提供商；同一提供商里换模型可以，**换提供商要新开会话**。
- agent 拿到的永远只是 worker 本机中继地址（127.0.0.1）+ 会话令牌：Pi 是一个 `-e` 会话扩展，OpenCode 是 `OPENCODE_CONFIG_CONTENT`（v1 `provider` / v2 `providers`），Grok 是每会话私有 `GROK_HOME`。全局配置文件不改。
- 不选 hub 模型时一切照旧。

## 已知限制（v1）
- 经 hub 中转的句柄只在 hub 内存里：hub 重启后，被接回的、还在跑的会话的中转请求会 404，需要新开会话。
- 不提供「禁用原生模型」。
