# 内置资产：改动前后

`before/` 是审计时的截图（项目设置·资产只有手动加的资产，资产页没有现成的可选），`after/` 是本分支 e2e 截的图（`E2E_SCREENSHOTS`）。数据都是本地临时 Hub 的模拟数据，GitHub 令牌是假的。

| 文件 | 看什么 |
| --- | --- |
| `before/asset-d-11-project-assets.png` | 改动前：项目设置·资产，要先自己上传或贴 JSON |
| `before/asset-d-01-market-catalog.png` | 改动前：资产页没有现成可选的 |
| `after/builtin-list-1280.png` | 内置资产清单：「内置」标、锁定版本、来源与许可证；Playwright 标出 0/1 台机器装了 Chromium，可一键装 |
| `after/builtin-secret-1280.png` | GitHub 要令牌：先填密钥，填了才能启用 |
| `after/builtin-enabled-1280.png` | Playwright、GitHub 已启用 |
| `after/builtin-390.png` | 手机宽度；上方项目资产列表里启用的两项带「内置」标 |
