# 账号体系设计（邮箱注册 + Google 登录）

状态：设计稿，待评审，**本轮不实现**
日期：2026-10-25 · 配套 ADR：[0008](../adr/0008-accounts.md)

## 0. 一句话

给 hub 加上「谁在用」这件事：邮箱注册（带验证）、密码登录与重置、Google 登录；用每台机器自己的接入凭据替换共享的 `HUB_TOKEN`；权限模型 v1 只有 **一个 Owner + 受邀成员**，仍然不做多租户。

## 1. 目标与非目标

目标
- 邮箱 + 密码注册，邮件验证；登录、登出、忘记密码。
- Google 登录（OIDC，授权码 + PKCE + state + nonce），能按「已验证邮箱」与已有账号关联。
- 浏览器用 httpOnly cookie，脚本/CLI 用 Bearer 个人令牌；有 CSRF 防护。
- Worker 接入改为「按用户签发、可吊销的接入令牌」，不再共享一个 `HUB_TOKEN`。
- 现有的无令牌 / `HUB_TOKEN` 部署平滑升级，已有数据归首个 Owner。

非目标（v1）
- 多租户、组织、计费、SSO（SAML）、细粒度角色。
- 除 Google 以外的 OAuth 提供方（端口留好，暂不接）。
- 2FA / Passkey（列入 Phase 4 候选）。

## 2. 与「不做多租户」的关系

README 与 `docs/product/positioning.md` 第 76 行写着「不做多租户隔离……领域模型留 Owner 字段，UI 不做，权限模型不倒推」。本设计**不推翻**这条：

- 一个 hub 实例 = 一个 **Workspace**（隐式、唯一，不建表，不出现在 UI）。所有项目、Worker、会话都属于它。
- 账号只回答两个问题：**你是谁**（认证），**你是 Owner 还是 Member**（两档授权）。
- 不做「A 看不到 B 的项目」这种隔离。成员之间互相可见，是一个家庭 / 小团队共用自己机器的模型，不是 SaaS。
- 将来真要多租户，是把隐式 Workspace 变成显式表 + 给资源加 `workspace_id`；本设计的表结构已为此留缝（见 §8），但不提前做。

推荐理由：用户的场景是「自己的几台机器 + 手机 + 偶尔给家人/同事一个号」。按资源 ACL 做隔离，复杂度会翻倍，而且 agent 本身就能读写 Worker 上的整个目录——在同一台 Worker 上谈隔离是假的安全感。

## 3. 术语（拟补入 GLOSSARY）

GLOSSARY 里 **Session** 已经指「一次持续的对话」，所以登录态**不能叫 Session**。

| 术语 | 含义 | 避免 |
|---|---|---|
| **User** | 一个能登录 hub 的人。有一个主邮箱、显示名、角色（owner / member）。 | 账户（含糊）、Account、Member（作名词时） |
| **Identity** | User 的一种登录方式：`password`（邮箱+密码）或 `google`（Google `sub`）。一个 User 可有多个。 | Provider、OAuth Account |
| **登录态（Login）** | 一次已认证的浏览器或令牌登录，可列出、可单独登出。 | Session（与对话冲突）、Token（单独使用） |
| **个人令牌（Personal Token）** | 给脚本 / CLI 用的长期 Bearer 凭据，本质是一种登录态。 | API Key |
| **Pairing Token**（已有） | 允许一台 Worker 加入 hub 的一次性凭据。本设计让它**按用户签发**，兑换后变成 Worker 凭据。 | — |
| **Worker 凭据（Worker Credential）** | Worker 兑换 Pairing Token 后拿到的长期凭据，可吊销。 | HUB_TOKEN |
| **邀请（Invite）** | Owner 发给某个邮箱的一次性注册链接。 | — |

## 4. 领域模型

```
User ──1:n── Identity            (password | google)
  │
  ├──1:n── Login                 (cookie 登录态 / 个人令牌；只存哈希)
  ├──1:n── PairingToken ──兑换──▶ WorkerCredential ──1:1── Worker(已有，适配器)
  └──1:n── Invite (owner 发出)

OneTimeToken: 邮箱验证 / 重置密码（只存哈希，一次性，短时效）
Project / Task / Session(对话)：新增 createdBy: UserId（审计用，不做隔离）
```

聚合
- **User**（聚合根）：`id, email(规范化小写), emailVerifiedAt, displayName, role: 'owner'|'member', disabledAt, createdAt`。不变式：系统中至少一个未禁用的 owner；`email` 唯一。
- **Identity**：`(provider, subject)` 唯一。password 身份的 subject = 规范化邮箱，附 `passwordHash`；google 身份的 subject = Google `sub`（**不是邮箱**，邮箱会变），附 `email、emailVerified` 快照。
- **Login**：`id, userId, kind: 'browser'|'personal', tokenHash, label, createdAt, lastSeenAt, expiresAt, ip, userAgent`。
- **PairingToken / WorkerCredential**：见 §7。
- **OneTimeToken**：`purpose: 'verify-email'|'reset-password'|'invite', tokenHash, userId|email, expiresAt, usedAt`。

纯函数（domain，可单测）：邮箱规范化、密码策略、「Google 身份能否关联到已有 User」判定、登录态续期策略、角色判定 `can(user, action)`。

## 5. 端口与适配器

六边形边界：domain 只认识端口；所有 IO（哈希、发信、HTTP 到 Google、随机数、时钟、sqlite）都在适配器。

| 端口（packages/domain/src/ports） | 职责 | v1 适配器 |
|---|---|---|
| `UserRepository` | User + Identity 的读写、按邮箱/按 (provider,subject) 查 | `storage-sqlite` |
| `LoginRepository` | 登录态、个人令牌、OneTimeToken、PairingToken、WorkerCredential（都是「哈希 + 过期」） | `storage-sqlite` |
| `PasswordHasher` | `hash(pw)` / `verify(pw, hash)` / `needsRehash(hash)` | `node:crypto` scrypt（零原生依赖）；可选 `@node-rs/argon2`（argon2id） |
| `TokenIssuer` | 生成高熵随机令牌并给出其哈希（SHA-256）；常量时间比较 | `node:crypto` |
| `EmailSender` | 发验证 / 重置 / 邀请邮件（模板在 domain 之外） | `smtp`（nodemailer）、`resend`（HTTP）、`console`（开发与未配置时把链接打到 server 日志） |
| `OAuthProvider` | `authorizeUrl({state, nonce, codeChallenge, redirectUri})`、`exchange(code, verifier, redirectUri) → {subject, email, emailVerified, name}`（已校验 id_token 的 iss/aud/exp/nonce） | `google`（基于 `openid-client`） |
| `Clock` | `now()` | 已有 `deps.now` 复用 |
| `RateLimiter` | `hit(key, rule) → allowed / retryAfter` | 内存滑动窗口（单进程足够）；sqlite 版备选 |

用例（packages/domain/src/use-cases/accounts/*）：`bootstrapOwner`、`registerWithPassword`、`verifyEmail`、`loginWithPassword`、`requestPasswordReset`、`resetPassword`、`startGoogleLogin`、`finishGoogleLogin`、`linkIdentity`/`unlinkIdentity`、`logout`/`revokeLogin`、`issuePersonalToken`、`invite`/`acceptInvite`、`issuePairingToken`、`enrollWorker`、`revokeWorker`、`authenticate(request credential) → Principal`。

HTTP 层（apps/server）只做：解析 cookie / header → 调 `authenticate` → 把 `Principal` 放进上下文 → 调用例。和 PR #2 抽出用例时同一个纪律。

## 6. 流程

### 6.1 首次启动（Bootstrap）
- 库里没有 User 时，hub 进入「待认领」状态：除 `/setup` 与静态资源外，所有 API 返回 `409 needs_setup`。
- **谁能认领**：server 启动时生成一次性 **setup code**，打印到 server 日志 / 终端（类似 Jupyter、Grafana、Home Assistant 的首启）。在 `/setup` 页输入它 + 邮箱 + 密码（或 Google）创建第一个 User，角色 owner，邮箱视为已验证（setup code 证明了对机器的控制权）。
- 从 loopback 访问时可省略 setup code（本机即证明）。
- 已有 `HUB_TOKEN` 的部署：`HUB_TOKEN` 本身可当 setup code 用（见 §11 迁移）。

### 6.2 邮箱注册
- v1 默认 **只能通过邀请注册**（`HUB_SIGNUP=invite`，默认）；`open` 为可选（公开注册，新人一律 member）。理由：hub 能在你的机器上跑任意命令，开放注册等于开放 shell。
- 提交邮箱 + 密码（≥ 10 位，查常见弱口令表，不强制字符类别，参考 NIST 800-63B）→ 建 User（未验证）+ password Identity → 发验证邮件（链接含 32 字节随机令牌，库里只存 SHA-256，30 分钟有效，一次性）。
- 未验证的账号**能登录但只能看到「去验证邮箱」页**；邀请链接注册时，邀请本身已证明邮箱，直接视为已验证。
- 未配置发信（`EmailSender=console`）时：验证 / 重置链接打到 server 日志，Owner 也可在设置页手动标记某成员已验证。

### 6.3 登录
- 邮箱 + 密码 → `PasswordHasher.verify`。邮箱不存在时也跑一次假哈希，保证耗时一致（防枚举）。
- 错误统一为「邮箱或密码不对」。
- 成功后签发 browser 登录态；若 `needsRehash` 则顺手升级哈希。

### 6.4 忘记密码
- 提交邮箱 → **永远**回「如果这个邮箱注册过，我们已发出邮件」。
- 重置令牌 30 分钟、一次性；重置成功后**吊销该用户全部登录态**（除了当前这个新签发的），并发一封「密码已修改」通知。

### 6.5 Google 登录（OIDC）
1. `GET /api/auth/google/start?next=/…`：生成 `state`、`nonce`、`code_verifier`，存进一个 10 分钟、httpOnly、`SameSite=Lax`、路径限定 `/api/auth/google` 的临时 cookie（加 HMAC 签名）；302 到 Google，`scope=openid email profile`，`code_challenge_method=S256`。
2. `GET /api/auth/google/callback`：校验 `state` → 用 verifier 换 token → 校验 id_token（`iss`、`aud`=client_id、`exp`、`nonce`）→ 得到 `sub / email / email_verified`。
3. 账号匹配规则（domain 纯函数 `resolveGoogleIdentity`）：
   - 已有 `(google, sub)` 身份 → 登录该 User。
   - 否则若 `email_verified=true` 且有同邮箱的 User **且该 User 的邮箱也已验证** → 自动关联并登录（双方都证明了对邮箱的控制）。
   - 同邮箱 User 存在但**未验证** → **不**自动关联（防「抢注未验证邮箱」攻击）：提示「请先用密码登录后在设置里关联 Google」。
   - Google 返回 `email_verified=false` → 拒绝自动关联、拒绝新建。
   - 无匹配 → 按注册策略：`invite` 模式下需该邮箱有有效邀请；`open` 模式新建 member。
4. 已登录用户在设置里点「关联 Google」走同一流程，`state` cookie 里带 `linkTo=userId`，成功即添加身份（邮箱不一致也允许，但会显示出来）。
5. 解除关联：至少保留一种登录方式。
6. `next` 只接受站内相对路径（防开放重定向）。

**Redirect URI 与 tailnet 的现实**
- Google 不接受裸 IP（如 `100.x.y.z`）作为回调地址，只接受 `localhost` 或公网后缀域名，且非 localhost 必须 https。
- 所以 Google 登录只在 hub 有 **https 域名**时可用。推荐 `tailscale serve`（拿到 `https://<机器>.<tailnet>.ts.net`，只在 tailnet 内可达，证书自动）。在 Google Console 登记 `https://<host>/api/auth/google/callback`。
- 配置：`HUB_PUBLIC_URL`（回调地址的唯一来源，**不从请求的 Host 推导**，否则 Host 头可被用来伪造回调）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（只走环境变量/文件，不进库、不进日志）。
- 未配置时 UI 不显示 Google 按钮，邮箱登录照常可用。

## 7. 登录态、CSRF、Worker 接入

### 7.1 浏览器：cookie
- 令牌 32 字节随机，库里存 SHA-256（库泄露也不能直接登录）。
- https 时：`__Host-hub_login`，`HttpOnly; Secure; SameSite=Lax; Path=/`。
- http（tailnet 裸 IP，WireGuard 已加密）：浏览器不会给 http 存 `Secure` cookie，退化为 `hub_login; HttpOnly; SameSite=Lax`。设置页显示「建议启用 https」的提示。
- 时效：滑动 30 天，绝对 90 天；`lastSeenAt` 每小时最多写一次。
- 设置页列出全部登录态（设备、IP、最近使用），可逐个登出。

### 7.2 脚本 / CLI：Bearer 个人令牌
- 设置页生成，形如 `ahp_<随机>`（前缀便于密钥扫描），只显示一次，库里存哈希；可设到期、可吊销。
- 只认 `Authorization: Bearer`；**取消 `?token=` 查询参数**（顺手关掉第二轮审查 P2 那一条）。WebSocket 浏览器端靠 cookie。

### 7.3 CSRF
- 写请求已有 Origin 校验（PR #15 `request-guard.ts`）。在其上：
  - cookie 认证的非 GET 请求要求 `Origin` 存在且同源（不再放行缺失 Origin），**或**带 `X-Hub-CSRF` 头（双提交：值来自一个非 httpOnly 的 `hub_csrf` cookie）。前端 `api.ts` 统一加。
  - Bearer 认证的请求不需要 CSRF（浏览器不会自动带 header）。
- `SameSite=Lax` + Origin + 双提交，三层。

### 7.4 Worker 接入重做（取代共享 `HUB_TOKEN`）
> 已实现，落地细节见 [worker-enrollment.md](worker-enrollment.md)。与下面草案的差异：配对码经 `/worker` 长连接的 `enroll` 握手帧兑换（不是 hello 里带 `pairToken`；早期的 HTTP `POST /api/workers/enroll` 已拿掉），命令改为 `curl …/install-worker.sh | HUB_PAIR=… bash`；共享 `HUB_TOKEN` 保留为兜底。

现状：所有 Worker 和浏览器共用一个 `HUB_TOKEN`，泄露一次全部失守、无法单独吊销。

新流程（参考 Tailscale auth key、GitHub Actions self-hosted runner 注册令牌）：
1. 用户在「机器」页点「添加机器」→ 签发 **Pairing Token**（一次性、15 分钟、`ahw_pair_…`），页面给出一行命令：`HUB_URL=… HUB_PAIR=ahw_pair_… scripts/install-worker.sh`。
2. Worker 首次连接在 hello 里带 `pairToken` + 自报 workerId/label → server 兑换：作废 Pairing Token，生成 **Worker 凭据**（`ahw_…`，32 字节，库里存哈希），回给 Worker；Worker 存进 `WORKER_STATE_DIR`（文件权限 0600）。
3. 之后每次 hello 带 `credential`。workerId 由凭据决定（一个凭据绑定一个 workerId），**hello 自报的 id 不再可信**——这把 PR #15 的「4409 抢占」规则变成结构性保证。
4. Worker 属于签发它的 User（`enrolledBy`），在唯一 Workspace 内对所有成员可用；Owner 可吊销任何 Worker，Member 只能吊销自己接入的。吊销 = 删凭据 + 立刻断开连接（关闭码 4401），其会话按「Worker 离线」处理。
5. 本机 Worker 保持 PR #15 的 `localSecret` 机制，不需要配对。

## 8. 授权模型（v1）

| 动作 | Owner | Member |
|---|---|---|
| 看 / 用所有项目、任务、会话、画布 | ✓ | ✓ |
| 建项目、在任何在线 Worker 上开会话 | ✓ | ✓ |
| 删除项目 / 任务 | ✓ | 仅自己创建的 |
| 添加机器（签发 Pairing Token） | ✓ | ✓（可由 Owner 关掉：`HUB_MEMBERS_CAN_ENROLL`） |
| 吊销机器 | ✓ | 仅自己接入的 |
| 邀请、禁用成员、改角色 | ✓ | ✗ |
| 改 hub 设置（注册策略、发信、Google） | ✓ | ✗ |

实现：domain 一个纯函数 `can(principal, action, resource?)`，用例开头调用；HTTP 层不写权限判断。资源上的 `createdBy` 只服务于「删除自己的」与审计。

## 9. 限流与防爆破

| 键 | 规则 |
|---|---|
| 登录：每 IP | 20 次 / 10 分钟 |
| 登录：每邮箱 | 5 次失败后指数退避（1s→2s→…→上限 15 分钟），成功清零；不锁死账号（防恶意锁号） |
| 注册 / 忘记密码 / 重发验证：每 IP 与每邮箱 | 5 次 / 小时 |
| setup code 尝试 | 10 次后 setup code 作废并重新生成（打日志） |
| Pairing Token 兑换：每 IP | 10 次 / 10 分钟 |

IP 取 socket 地址；只有设置 `HUB_TRUST_PROXY=1` 时才看 `X-Forwarded-For`（tailscale serve 场景）。

## 10. 安全清单

- 防邮箱枚举：登录、忘记密码、注册（邮箱已存在时也回「请查收邮件」，并给原邮箱发一封「有人尝试用你的邮箱注册」）响应一致、耗时一致。
- 所有令牌（登录态、个人令牌、验证/重置/邀请、Pairing、Worker 凭据）只存 SHA-256；比较用 `timingSafeEqual`。高熵随机令牌不需要加盐慢哈希。
- 密码：scrypt（N=2^17, r=8, p=1）或 argon2id（m=19MiB, t=2, p=1，OWASP 推荐值）；哈希串自带参数，`needsRehash` 支持升级。
- 改密码、重置密码、解除关联、禁用用户 → 吊销相关登录态。
- OAuth：PKCE S256 + state + nonce；回调地址来自 `HUB_PUBLIC_URL`；`next` 只收站内路径；id_token 走 `openid-client` 校验。
- 日志：不记录密码、令牌、Google client secret、邮件链接（console 发信模式除外，且明确标注）。
- 已有 Host/Origin 守卫（PR #15）保留，DNS rebinding 防护不变。

## 11. 从现有部署迁移

现有三种形态：
1. **无令牌、只绑 127.0.0.1**：升级后首次打开即进入 `/setup`；从 loopback 访问免 setup code。认领者成为 Owner。
2. **`HUB_TOKEN` + tailnet**：升级后 `HUB_TOKEN` 可作为 setup code。认领前，旧 `HUB_TOKEN` 仍可让**已有 Worker** 连上（过渡模式，日志里每天提醒一次）。Owner 在「机器」页能看到「旧式共享令牌接入的 N 台」，一键为每台生成 Pairing 命令；全部迁完后点「停用共享令牌」。下个大版本删除 `HUB_TOKEN`。
3. **浏览器里存着 `?token=` 的手机**：旧 token 不再当登录凭据，打开后跳到登录页。

数据归属：迁移脚本把所有已有 Project / Task / Session 的 `createdBy` 设为第一个 Owner；已登记的 Worker 的 `enrolledBy` 同样设为 Owner。不改任何现有 ID、落点、血缘。

## 12. API

所有路径前缀 `/api/auth`，除特别说明外请求/响应为 JSON。

| 方法 路径 | 说明 |
|---|---|
| `GET /api/auth/state` | `{needsSetup, signup: 'invite'|'open', google: boolean, me: User|null}`，前端启动先调它 |
| `POST /api/auth/setup` | `{setupCode?, email, password, displayName}` → 建 Owner + 登录 |
| `POST /api/auth/register` | `{email, password, displayName, invite?}` |
| `POST /api/auth/verify-email` | `{token}` |
| `POST /api/auth/resend-verification` | — |
| `POST /api/auth/login` | `{email, password}` → Set-Cookie |
| `POST /api/auth/logout` | 当前登录态 |
| `POST /api/auth/password/forgot` | `{email}` → 永远 204 |
| `POST /api/auth/password/reset` | `{token, password}` |
| `POST /api/auth/password/change` | `{current, next}` |
| `GET /api/auth/google/start?next=` | 302 |
| `GET /api/auth/google/callback` | 302 到 `next` 或带错误码的 `/login` |
| `DELETE /api/auth/identities/:provider` | 解除关联 |
| `GET /api/auth/logins` · `DELETE /api/auth/logins/:id` | 登录态列表 / 登出某个 |
| `POST /api/auth/tokens` · `DELETE /api/auth/tokens/:id` | 个人令牌 |
| `GET/POST /api/users` · `PATCH /api/users/:id` | Owner：列成员、邀请、禁用 / 改角色 |
| `POST /api/workers/pairing` | 签发 Pairing Token，返回一行安装命令 |
| `DELETE /api/workers/:id` | 吊销机器 |

WebSocket `/worker` 的 hello（contract/wire.ts）新增 `pairToken?` / `credential?`；server 回 `enrolled{credential}`。

## 13. 数据库（storage-sqlite 迁移）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, email_verified_at INTEGER,
  display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')),
  disabled_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE identities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, subject TEXT NOT NULL,
  password_hash TEXT, email TEXT, email_verified INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE logins (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser','personal')), token_hash TEXT NOT NULL UNIQUE,
  label TEXT, ip TEXT, user_agent TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE one_time_tokens (
  token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, email TEXT,
  role TEXT, created_by TEXT, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE worker_credentials (
  worker_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  enrolled_by TEXT NOT NULL REFERENCES users(id), label TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
CREATE TABLE pairing_tokens (
  token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, used_at INTEGER, worker_id TEXT
);
ALTER TABLE projects ADD COLUMN created_by TEXT;
ALTER TABLE tasks    ADD COLUMN created_by TEXT;
ALTER TABLE sessions ADD COLUMN created_by TEXT;
```

将来多租户的缝：加 `workspaces` 表与各表 `workspace_id`，`users.role` 移到 `memberships(user_id, workspace_id, role)`。v1 不建。

## 14. 界面（移动优先，沿用 visual-direction.md）

参考：Linear（登录页极简，一个邮箱框 + 「用 Google 继续」）、Vercel / Tailscale（设置页的设备与令牌列表）、Home Assistant / Grafana（首启认领页）。

- **登录页 `/login`**：页面正中一张窄卡（手机上撑满宽度，左右 20px 留白）。顶部 hub 名称；「用 Google 继续」大按钮（未配置时不出现）；分隔线「或」；邮箱、密码两个输入框（`autocomplete="email"`/`current-password`，手机唤起邮箱键盘）；主按钮「登录」；底部一行小字「忘记密码」·「有邀请？注册」。错误只出现在按钮上方一行，不弹窗。
- **注册页 `/register?invite=`**：邀请链接进入时邮箱已填好且只读；显示名、密码（带「显示」切换与一行强度提示，不搞彩条）；「创建账号」。
- **验证页 `/verify`**：一个大图标 + 「去 xxx@… 查收邮件」+「重新发送（60s 倒计时）」+「换个邮箱」。点邮件链接后自动跳回首页，不需要再点。
- **重置页 `/reset`**：输入新密码一次（带显示切换），完成后直接登录。
- **首启 `/setup`**：一步表单：setup code（loopback 时隐藏）、邮箱、显示名、密码；顶部一句「第一个账号会成为这台 hub 的主人」。
- **设置 `/settings`**（手机上是分组列表，桌面是左侧导航）：
  - 账号：头像字母、显示名、邮箱（验证状态徽标）、修改密码、关联 / 解除 Google。
  - 登录设备：每行「设备 · 位置/IP · 最近使用」，右侧「登出」；顶部「登出其他所有设备」。
  - 个人令牌：列表 + 「新建」，新建后弹一次性展示与复制按钮。
  - 机器（与现有 Worker 面板合并）：每台机器的在线点、接入人、最近在线、「吊销」；「添加机器」弹出一行可复制命令与 15 分钟倒计时。
  - 成员（仅 Owner）：列表、角色、「邀请」（输入邮箱 → 生成链接，未配发信时直接给链接复制）。
- 顶栏右上角头像 → 菜单：设置、登出。

## 15. 复用评估

| 候选 | 结论 | 理由 |
|---|---|---|
| **better-auth** | 不用 | 功能全、维护活跃，但它自带路由、表结构与插件体系，等于把一个用例层塞进适配器之外；领域里的 User/Identity/权限会被它的模型反向绑定，违背六边形（ADR 0001）。 |
| **Lucia** | 只借鉴模式 | v3 包已弃用，官网只留「如何自己写」的范例；其模式（随机令牌 + 存哈希 + 滑动过期）正是 §7.1 的做法，几十行即可，放在 domain + `TokenIssuer`。 |
| **Arctic / Oslo** | 不用 | 2026-07 作者宣布弃用（只保留 `@oslojs/encoding`）。 |
| **openid-client**（panva） | 用，作为 Google 适配器的底座 | 持续维护、OIDC 认证实现，处理 discovery、PKCE、id_token/nonce 校验；只出现在 `adapters/oauth-google`，domain 不感知。 |
| **node:crypto scrypt** | 默认 PasswordHasher | 零依赖、零原生编译（Worker 安装脚本更简单）。 |
| **@node-rs/argon2** | 可选适配器 | argon2id 更优，预编译二进制；若评审更看重算法强度可替换，端口不变。 |
| **nodemailer / Resend SDK** | 各做一个 EmailSender 适配器 | 都很薄；默认 console。 |

## 16. 分期与工作量

> 2026-10-25 按 §17 的决定重排。P1 已实现（见下）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1 地基** | domain：User / Login、端口、用例（注册/登录/登出/认证/HUB_TOKEN 换登录/种子账号）；sqlite `users`、`logins` 两表；`adapter-accounts`（scrypt、令牌签发、Resend + 日志发信）；server `/api/auth/*`、守门中间件、cookie + 双提交 CSRF、登录/注册/HUB_TOKEN 限流；HUB_TOKEN 30 天过渡（Bearer 与换登录）；内置测试账号；前端登录/注册页（移动优先）、登录闸门、账号菜单与退出；e2e 登录 | ✅ 已完成 |
| **P2 运营后台** | `/admin`（仅 Owner）：用户列表（邮箱、角色、注册时间、最近登录、状态）、停用/启用（停用即删其全部登录态）、改角色（至少保留一个 Owner）、机器列表（label、在线状态、谁加的、最近心跳）。界面同 visual-direction.md：一列卡片，手机上每行可点开操作，不做表格横滑 | 待做 |
| **P3 邮件流程** | 邮箱验证、重发、忘记/重置密码、登录设备列表与踢下线；Resend 已就绪，未配 `RESEND_API_KEY` 时只打日志 | 待做 |
| **P4 Worker 接入** | Pairing Token、凭据兑换与存储、hello 改造、吊销即断开；成员也能添加机器；30 天后 HUB_TOKEN 只剩 worker 通道用，P4 后彻底移除 | 待做 |
| **P5 Google** | `OAuthProvider` 端口已留桩；openid-client 适配器、start/callback、关联规则、`HUB_PUBLIC_URL` 与 tailscale serve（需要 https） | 待做 |
| **P6 收尾** | 个人令牌、删除 `?token=`、所有权转让 / 删除账号 | 待做 |
| 候选 | Passkey / TOTP、更多 OAuth 提供方 | — |

每阶段一个 PR，ci 与 e2e 全绿后合并。

## 17. 已决定（2026-10-25）

1. **开放注册**。另内置一个测试账号：邮箱由 `HUB_TEST_ACCOUNT` 配置（默认 `test@agent-hub.local`，设为 `off` 关闭），角色 Owner；密码首次启动随机生成，写进 `~/.config/agent-hub/test-account`（mode 600，可用 `HUB_TEST_ACCOUNT_FILE` 改路径），绝不打日志；设置 `HUB_TEST_ACCOUNT_PASSWORD` 时改用该密码（不受强度规则限制），每次启动把账号和密码文件对齐到它。因为它是 Owner，之后注册的人都是成员；没有任何 Owner 时第一个注册的人成为 Owner。
2. 成员之间**全部互相可见**。
3. **成员能添加机器**（P4 落地）。
4. 密码哈希用 **scrypt**（node:crypto，零原生依赖；N=2^17、r=8、p=1，参数编码进哈希串，以后可调）。
5. 发信用 **Resend**（直接 fetch 其 HTTP API，不引 SDK）；没配 `RESEND_API_KEY` 时退化为只打日志。发件人 `HUB_MAIL_FROM`。
6. **Google OAuth 保留设计，后面再接**：本期只有端口桩。
7. **允许 http 测试**：cookie 只在 https（或 `X-Forwarded-Proto: https`）下加 `Secure` 与 `__Host-` 前缀。
8. 旧 `HUB_TOKEN` **保留 30 天**：从账号版第一次启动起算（起点记在数据目录 `hub-token-since`，重启不续命，`HUB_TOKEN_SUNSET_DAYS` 可调）。期内 Bearer / `?token=` 照常调 API，也能在登录页「HUB_TOKEN」页签换成最早那个 Owner 的登录；旧链接 `?token=…` 自动兑换。worker 通道在 P4 之前仍用它。
9. **支持停用账号**（停用即拒绝登录、已有登录态失效），并提供**运营后台**（P2，见 §16）。
10. 登录态**滑动 30 天**（每小时最多续一次）。
