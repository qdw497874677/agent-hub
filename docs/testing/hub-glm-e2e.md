# 用 Hub 供应商跑完整 E2E（glm-5.3-flash）

只在要真 Pi 走 Hub 供应商时用。未设置 `E2E_HUB_MODEL` 时，套件和以前一样传空模型。

假 ACP 仍是 `fakeacp` + 空模型。Hermes 仍用用例里的本地假网关，不改成 GLM。故意删掉工作目录再等失败的用例保持原样；目录在启动前就没了，一般不会打到上游。

## 密钥边界

`ZAI_CODING_CN_API_KEY` 只留在**启动 Playwright 的那个进程**里，给登录后的 `POST /api/providers` 用。不要写进文件、argv、日志或源码。

Playwright 启动 webServer 的实际对象是 `{ ...默认值, ...process.env, ...config.env }`，并且 `shell: true`。这条 shell 跑的是 `npm run build && node apps/server/src/main.ts`。从 `config.env` 里 `delete` 掉的名字不会盖住前面的 `process.env`，shell、build、hub、以及 hub 拉起的本机 worker 都会继承。`e2e/server-env.ts` 把这些名字设成对象自己的 `undefined`。Node 在 spawn 时丢掉这种值，子进程的环境里没有这个名字。

任何模式都这样处理 `ZAI_CODING_CN_API_KEY` 和 `ZAI_API_KEY`。设置了 `E2E_HUB_MODEL` 时再同样处理 `PI_DEFAULT_MODEL`、`OPENCODE_API_KEY`、`OPENCODE_GO_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`。`HUB_PROVIDER_TOKEN` 不在这份名单里，会话中继令牌仍按原来的授权交给当次 Pi。

测试进程里另外拉起的远程 worker（`e2e/openapi.spec.ts`）也走同一份 `serverEnv()`，不把种子密钥和上述 Go 变量传进去。

登录成功后，第一个 `loginByApi` 若发现还没有这家全站供应商，就 `POST /api/providers` 一次。作用域是 `hub`（页面上的「全站」）：空库里的 `test@agent-hub.local` 是集群管理员，后面邀请出来的账号和别的团队也能用。个人或团队作用域盖不住这些账号。

不要把 `/workspace/glmhub-runtime` 指成 `E2E_DATA_DIR`。用一个新目录。

## 命令

```bash
unset PI_DEFAULT_MODEL OPENCODE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY
export E2E_DATA_DIR=/var/tmp/agent-hub-e2e-glm
export E2E_PORT=7897
export HOME=/var/tmp/agent-hub-e2e-glm-home
export WORKER_STATE_DIR="$HOME/.config/agent-hub"
export WORKER_ID=e2e-glm
export E2E_CHROME=/usr/bin/google-chrome
export E2E_HUB_MODEL=hub-cn-glm-flash/glm-5.3-flash
export E2E_HUB_PROVIDER_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4
# ZAI_CODING_CN_API_KEY 由启动这个进程的环境注入，不要写进脚本
mkdir -p "$E2E_DATA_DIR" "$HOME" "$WORKER_STATE_DIR"
node -e "const k=process.env.ZAI_CODING_CN_API_KEY; console.log(k ? 'ZAI_CODING_CN_API_KEY set len='+k.length : 'ZAI_CODING_CN_API_KEY unset')"
npm run e2e -- --workers=1 --reporter=line,json
```

`E2E_REAL=1` 才会跑 `chat-real`。`WORKER_HERMES=1` 才会跑 Hermes；它的模型仍是用例自己的假网关。

种子只发生一次。供应商已在且含 `glm-5.3-flash` 就跳过。标识对了但没有这个模型，会停下来要求换新的 `E2E_DATA_DIR`。

## 哪些路径会带上这个模型

- API 派生：在线 worker 的真 Pi（`model: piModel()`）。包括会发问的画布历史、文件、列表、真对话。开放 API 的远程会话也传 `piModel()`，但令牌要另带 `providers:use`。本机拒绝那条仍传空模型。
- 分叉：`list-view` 的 fork 同样带 `piModel()`。
- 群和 agent 消息：真要 Pi 回话的角色，`model` 字段写成 `piModel()`。这是产品本来就有的字段。专门断言「没写模型的主持人应 400」的那组角色仍是空模型。
- 画布和「新建持久工作空间」：点「开始」之前用 `#derive-model` 选中。清单不超过 8 个时是原生 `<select>`；更多时打开「选择模型」搜索。没有原生模型时列表里只有这一项。

## 产品边界

开放 API 要选用 hub 模型，令牌必须另带 `providers:use`。它包含 `provider.read` 和 `provider.use`，不含 `provider.manage`，也没有并进 `sessions:write`。只给 `provider.use` 仍会被「看不见这个提供商」拒绝。不勾选时，带 `hub-<标识>/<模型>` 的开会话会被拒绝。本人角色本来没有这项权限（例如 viewer）时，勾了也不通过。个人提供商和别的团队的提供商照旧拒绝。设置了 `E2E_HUB_MODEL` 时，建令牌会多勾「使用模型提供商」，远程那条会话才传这个模型。未设置时令牌和模型都和以前一样。

没有原生模型时，会话卡片的模型控件会带上这次显式选中的 hub 模型，所以卡片上能改。没选模型时「开始」仍是灰的；目录选好之后，用例用对话框里的真实控件再选模型，然后才断言「开始」可点。

令牌打本机 Worker 仍然先 403。机器没配原生模型时，不再把这次拒绝说成 503「未配置模型」。真的缺运行时、检测失败，仍然拒绝。

画布在「未配置模型」但已经有同协议 hub 模型时，可以先选这台机器和工作空间，再在模型控件里选 hub 模型。空模型不会被改成 hub 默认，「开始」在没选模型时仍然是灰的。

`messages-entry` 和 `perms` 里写死的 `agentId: 'grok'` 仍是空模型。那不是 Pi。建群那条「主持人必须显式带模型」的负例也仍是空模型。

假 ACP（`fakeacp`、`fakefork`）和 Hermes 自建的 `hub-<当次 slug>/m-1` 不读 `E2E_HUB_MODEL`。

Hermes 在全新 `HERMES_HOME` 里若先装 Python 依赖并以退出码 75 要求再启动，网关只再拉起一次。安装失败再退出 75 就停，不转圈。批准卡用例如果启动失败，也会关掉本地假模型服务，避免测试进程因为这个端口一直挂着。

交接、已知问题和尚未填的最终结果见 [pr211-handoff.md](pr211-handoff.md)。
