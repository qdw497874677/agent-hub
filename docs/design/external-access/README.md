# 外部接入（MCP）页：改动前后

后续改造见 [外部接入与 `ahub` CLI 改造计划](cli-plan.md)。该计划沿用现有外部接入授权与审计，不替换此页面。

`before/` 是审计时的访问令牌弹窗（明文令牌已打码），`after/` 是本分支 e2e 截的图（`E2E_SCREENSHOTS`），数据是本地临时 Hub 的模拟数据。

| 文件 | 看什么 |
| --- | --- |
| `before/mcp-d-02-tokens-dialog.png` | 改动前：外部接入藏在令牌弹窗里，权限要一个个勾 |
| `before/mcp-d-05-token-fresh.png`、`before/mcp-d-06-guide-cursor.png` | 改动前：新令牌明文直接显示并贴进配置片段 |
| `after/access-1280.png` | 独立页面：端点、写工具开关（管理员）、新建令牌、接入片段、令牌列表 |
| `after/access-create-1280.png` | 预设（只读 / 委派开发 / 资产自动化 / 自定义）、限定项目、默认 30 天 |
| `after/access-fresh-1280.png` | 新令牌只显示一次、默认打码；测试连接显示能用几个工具 |
| `after/access-activity-1280.png` | 令牌行：限哪个项目、最近使用、到期日、工具数；展开调用记录 |
| `after/access-writes-1280.png` | 管理员打开写工具开关后（e2e 最后会恢复服务器默认） |
| `after/access-390.png` | 手机宽度 |
