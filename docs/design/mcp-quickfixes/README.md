# MCP / 资产快修：改动前后对比

`before/` 是审计时（master a0faa89）的截图，`after/` 是这个分支的截图；同名文件一一对应（`-d-` 桌面 1440，`-m-` 手机 390）。
截图里的数据都是本地临时 Hub 的模拟数据；改动前截图里的明文令牌已打码（那个临时 Hub 已经删掉）。

| 文件 | 看什么 |
| --- | --- |
| `before/key-1-derive-503-annotated.png`、`before/mcp-d-08b-derive-error.png` | 改动前：启用 MCP 资产后派生会话 503「资产预热失败」 |
| `mcp-*-08-derive-assets.png` | 改动后：MCP 不再预热、不 503；缺密钥的 MCP 标红写明缺哪个密钥，默认不勾 |
| `mcp-*-02-tokens-dialog.png` | 令牌弹窗：默认 30 天、补「读资产」、权限写清实际包含什么、高风险标红 |
| `mcp-*-05-token-fresh.png` | 新令牌默认打码，点「显示」才露；接入片段只引用环境变量 |
| `mcp-*-06-guide-cursor.png` | Cursor 片段：`${env:AGENT_HUB_TOKEN}`，不再把明文令牌贴进配置 |
| `asset-*-01-market-catalog.png` | 资产页标题「资产」；MCP 不再显示「装到机器」 |
| `asset-*-02-admin-assets.png` | 运营后台资产：MCP 行说明「不用装到机器」，不再有装机开关 |
| `asset-*-05-git-error.png` | Git 导入失败：分清「仓库不存在 / 私有要令牌」和「令牌无效 / 没权限」 |
