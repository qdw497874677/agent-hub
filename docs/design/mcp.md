# MCP：三种形状一个内核

日期：2026-11-18 · 状态：多服务器 / OAuth / 按会话开关 / 资源与提示词 已实现（见 §5）

MCP 在本项目里有三个不同的位置，容易混：

| 形状 | 谁在用 | 走哪条路 |
| --- | --- | --- |
| hub 当服务器 | 外部 agent（Claude Code / Cursor / Codex / 脚本） | `POST /openapi/v1/mcp`，令牌鉴权，`ALLOWED` 白名单 |
| hub 当客户端入口 | 会话里的 agent 用 hub 自己的工具（任务、消息、记忆、git…） | worker 把 URL 换成本机 MCP 入口 → hub relay |
| 用户的 MCP 资产 | 会话里的 agent 用用户自己配的 MCP 服务器 | `mcp.json` 资产 → stdio 在 worker 拉起 / http 由 hub 代连 |

## 1. 资产：一份 mcp.json 可以放多个服务器

- 单服务器（老格式）：`{"name": "…", "transport": "stdio"|"http", …}`。
- 多服务器：`{"servers": [ … ]}` 或 Claude/Cursor 的 `{"mcpServers": {"名字": {…}}}`。
- 名字限制 `^[a-z0-9-]{1,64}$`，保留名 `agent-hub`，一份文件最多 20 台，同文件内不许重名。
- 服务器名是跨资产唯一的运行时标识（下发给 worker 的 `McpLaunch.name`），不同资产撞名时按资产名排序先到先得，后者跳过并在 `skipped` 里说明。

导入时的资产名：只有一个服务器就用它的名字；多个服务器要求上传/导入时给资产起名（否则报「给它起个名字」）。

## 2. 两种传输的边界

- **stdio**：命令在 worker 上以会话用户身份执行。密钥只展开进那个子进程的 env/args，不落库、不进日志。工具过滤**只能**靠配置里的 `tools` 在本机过滤（worker 侧执行），hub 看不到也不该看到这些服务器。
- **http**：由 hub 代连（`remoteMcpTarget`），密钥留在 hub 内存，worker 只拿到本机中转地址。所以 hub 可以做工具过滤、OAuth、资源与提示词转发。

## 3. OAuth（client_credentials）

`mcp.json` 的 http 服务器可以写：

```json
{
  "name": "vendor",
  "url": "https://vendor.example/mcp",
  "oauth": {
    "tokenUrl": "https://vendor.example/oauth/token",
    "clientId": "agent-hub",
    "clientSecret": "${secret:VENDOR_CLIENT_SECRET}",
    "scope": "mcp.read",
    "authStyle": "basic"
  }
}
```

- `clientSecret` 与 `clientId` 都可以写 `${secret:NAME}` 引用；hub 在代连时展开（`remoteMcpTarget`），只存在内存里。
- `authStyle`：`basic` = `Authorization: Basic base64(id:secret)`，`post` = 客户端凭据放表单。
- token 按 `tokenUrl+clientId+scope+audience` 缓存，`expires_in` 提前 60 秒视为过期；上游 401 时强制刷新一次并重试一次，再失败就把错误交回调用方。
- 不做授权码流（没有用户交互面），也不刷新 refresh_token。

## 4. 工具级开关

`tools` 三写法等价：`["a","b"]`（allow）、`{"allow":[…],"deny":[…]}`、`denyTools:[…]`。deny 优先；allow 缺省表示全放行。

- http：hub 在 `ListTools` 结果里过滤，`CallTool` 命中被禁的直接报错，不打到上游。
- stdio：hub 与 worker 都不经手这个连接（agent 直接拉起进程），所以过滤**不可强制**——`tools` 只是随 `McpLaunch` 下发的元数据，界面上要说明「stdio 的工具开关仅作提示，真正限制要靠服务器自身配置」。

## 5. 按会话启停

`Session.mcpDisabled: string[]`（服务器名）+ `PATCH /api/sessions/:id/mcp`。只影响这条会话启动时下发的清单，不动资产与机器安装。改完要重启会话进程才生效（与模型/选项一致）。

界面读 `GET /api/sessions/:id/mcp`：返回这条会话资产快照里的 MCP 服务器（∩ 机器上已安装的版本）、当前关掉的清单，以及在拿不到版本时的说明（机器不在线 / 资产里没有 MCP）。关掉的服务器不会出现在「生效清单」里，但会保留在 `disabled` 中，将来装了同名服务器仍旧是关的。

## 6. 资源与提示词

http 服务器（hub 代连的那条）转发 `resources/list`、`resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get`，capabilities 相应声明。stdio 服务器由 worker 直接连，不经 hub，因此这些能力只在 agent 直连时可用。

## 7. 不做 / 边界

- **通知与 sampling**：worker 的 MCP 端点目前每条 HTTP 请求一个无状态 transport，hub relay 也是每条消息新建 Server。要做 `notifications/*` 与 `sampling/createMessage`，需要把 worker 端点改成按会话有状态、hub relay 持久化 `(token, server)` 的 Server，并新增 hub→worker 推送帧（协议 v8）。单独一期，先设计再动协议。
- 旧式 SSE 传输不支持（`streamable-http` 与 `sse` 都在导入时拒绝）。
- `MCP_*` 环境变量（`MCP_READ_ONLY` / `MCP_MODULES`；`MCP_WRITE=0` 等于只读，`MCP_WRITE=1` 已是默认行为）只管 hub 自己那套工具，不管用户资产。
