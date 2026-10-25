# 0008. 账号体系：单 Workspace、Owner + 成员、按机器签发接入凭据

Status: proposed（草案，待评审）
日期: 2026-10-25

## 背景

用户要求：「设计一下账号体系，要支持邮箱注册，Google OAuth」。

现状只有一个共享的 `HUB_TOKEN`：它同时是浏览器的 Bearer、手机地址栏里的 `?token=`、所有 Worker 的接入密钥。泄露一次就全部失守，也没法只吊销一台机器或一部手机。另一方面，`docs/product/positioning.md` 明确「不做多租户隔离……领域模型留 Owner 字段」。

## 决定

1. **一个 hub = 一个隐式 Workspace**，不建表、不出现在 UI。账号只解决「你是谁」和「Owner 还是 Member」两档授权，不做资源级隔离。与「不做多租户」一致。
2. 新概念 **User**、**Identity**（password / google）、**登录态**、**个人令牌**、**Worker 凭据**、**邀请**。登录态不叫 Session，因为 GLOSSARY 里 Session 是对话。
3. 认证与授权都在 domain：端口 `UserRepository`、`LoginRepository`、`PasswordHasher`、`TokenIssuer`、`EmailSender`、`OAuthProvider`、`RateLimiter`，复用已有 `now`；纯函数 `can()` 做权限判断，`resolveGoogleIdentity()` 做关联判定。HTTP 层只解析凭据。
4. 浏览器用 httpOnly cookie（https 时 `__Host-` + `Secure`），配 SameSite=Lax + Origin 校验 + 双提交 CSRF 头；脚本用 Bearer 个人令牌；删除 `?token=`。
5. 所有令牌只存 SHA-256；密码默认 scrypt（端口允许换 argon2id）。
6. Google 用 OIDC 授权码 + PKCE + state + nonce，基于 `openid-client`；回调地址只来自 `HUB_PUBLIC_URL`。只有「双方邮箱都已验证」才自动关联。
7. Worker 改为**按用户签发的一次性 Pairing Token → 兑换长期 Worker 凭据**，workerId 由凭据决定，可单独吊销；本机 Worker 保留 `localSecret`。`HUB_TOKEN` 进入过渡期后删除。
8. 首启由 setup code（或 loopback / 旧 `HUB_TOKEN`）认领第一个 Owner；已有数据归它。
9. 默认**仅邀请注册**。

## 被否决的方案

- **better-auth**：自带路由与表结构，会把用户模型从 domain 移到第三方库里。
- **Lucia / Arctic / Oslo**：已弃用；只借鉴 Lucia 的令牌模式。
- **按项目 ACL 的多用户隔离**：同一台 Worker 上 agent 能读写整个目录，隔离是假的；复杂度翻倍。
- **JWT 登录态**：无法单独吊销，hub 是单进程有状态服务，没有无状态的需要。

## 后果

好的：泄露的手机或机器可单独吊销；Worker 身份由凭据决定，PR #15 的抢占规则变成结构保证；多租户以后有缝可扩。

代价：多 6 张表、约 14 天工作量；Google 登录要求 https 域名（tailnet 裸 IP 不行）；http 下 cookie 不能带 `Secure`；旧部署需要一次认领与 Worker 重新配对。

详见 [docs/design/accounts.md](../design/accounts.md)。
