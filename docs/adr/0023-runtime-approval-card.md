# ADR 0023：运行时批准卡（通用）

- 状态：accepted（2026-11-01 David：「运行时要批准时推一张允许 / 拒绝卡，先 Hermes，设计通用，超时 = 拒绝，去掉 Hermes 自动 once」）
- 相关：ADR 0022（Hermes 适配器，设计文档 §6、§15、§18）、ADR 0020（旁路事件 context_usage / compaction 的先例）

## 背景

Hermes 的工具调用要批准时停在 `waiting_for_approval`。P1 里 hub 没有批准卡，适配器自动回 `once`——等于没有批准。别的运行时（ACP 的 permission request 等）以后也会有同样的需要。

## 决定

1. **新增旁路事件 `approval`**（SessionEvent 第 11 个变体）：
   - `phase: 'request'`：`{id, title, detail?, expiresAt}`——对话里出一张「允许 / 拒绝」卡；
   - `phase: 'resolved'`：`{id, decision: allow|deny, by: user|timeout|runtime, author?}`——同一张卡写上结论，不再给按钮。
   - 旁路（`isSideChannel`）：不改会话状态，不算「这一轮的活动」，不进画布卡片的内容判定。
2. **超时 = 拒绝，在运行时侧计时**：领域里的 `createApprovalGate`（发卡、计时、收答案、会话关闭全部拒绝）。hub、网页都离线时也照样收尾。默认 **180 秒**，比 Hermes 自己的 `approvals.timeout`（300 秒）短，结论一定是 hub 定的。
3. **回答走 hub**：`POST /api/sessions/:id/approvals/:approvalId {decision}`，权限 `session.prompt`（能让它干活的人才能批准它干活）；服务端只认事件流里还开着、没过期的请求，否则 409；记审计 `session.approval.respond`。转给 worker 的命令 `{kind:'approval', sessionId, approvalId, decision, author?}`；老 worker 不认就只记日志，运行时那边超时拒绝。
4. **运行时端口**：`RuntimeSession.respondApproval?(id, decision, author?)`，可选。不要批准的运行时不用实现。
5. **Hermes**：去掉自动 `once`。允许 → `once`，拒绝 / 超时 / 会话关闭 → `deny`；**从不发 `session` / `always`**（不在 Hermes 里留永久授权）。一轮结束时还开着的卡收掉（`by: runtime`）。对账把 `waiting_for_approval` 也算还在跑。澄清（clarify）不变：仍回固定的「用户不在，自己判断」。
6. **网页**：卡片在对话里；手机上两个按钮整行、至少 44px 高；带倒计时，到 0 不再给按钮。

## 保守选择（ADR 没说的，列给 David）

- 超时 180 秒，不可配（以后要配再加项目设置）。
- 只有「允许这一次」，没有「本会话都允许」/「总是允许」。
- ACP 运行时（Claude Code / Codex 等）的自动放行**没动**，它们的批准接入是后续工作（端口和卡片已经通用）。
- Hermes 仍是 opt-in，默认关。
- 澄清请求不做成卡片（只有批准）。

## 后果

- 新事件进 journal；老网页不认 `approval` 只是不显示（旁路），不影响别的。
- 有人在场才能批准：没人看时危险命令一律 180 秒后被拒，这一轮继续（Hermes 收到 deny 会让模型换办法）。
