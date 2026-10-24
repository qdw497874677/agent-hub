# 0004 同一会话的事件必须串行落盘

- 状态：accepted
- 日期：2026-10-24

## 背景

`recordEvent` 是「读会话 → 算 `lastSeq + 1` → 写 journal → 更新游标」的读改写。
网关把 worker 的每条事件交给一个独立的 async 任务，于是同一个会话的多条事件会
并发进入这段代码，读到同一个 `lastSeq`，算出同一个 `seq`。

`journal` 的主键是 `(session_id, seq)`，写入用的是 `INSERT OR IGNORE`——后到的那条
被**静默丢弃**，既不报错也不留痕。同时 `sessions.append` 里的文本投影
(`session_text`) 不做去重，于是两个副本开始互相矛盾：投影里那句话是完整的，
journal 里缺几条。

它是这样暴露的：Pi 回一句「E2E-OK-xxx」，卡片上显示成「E2-xxx」。查库才看到
journal 只有 3 条 text 行，而 `session_text` 是完整的。

## 决定

**同一 session 的事件串行写入，不同 session 之间并行。**

在组合根（`apps/server/src/main.ts`）用一个按 `sessionId` 分键的 promise 链
（`createSessionQueue`）包住 `recordEvent`。上一个任务失败也继续放下一个，
避免一个坏事件把会话永久卡死。

## 为什么不是别的做法

- **改 `INSERT OR REPLACE`**：让后到的覆盖先到的，seq 一样仍然丢一条，只是丢得更理直气壮。
- **让数据库分配 seq**（自增或 `MAX(seq)+1` 子查询）：`MAX(seq)+1` 在同一条 `INSERT ... SELECT`
  里能原子，但 `applyEvent` 需要「事件之后的状态」来算会话状态位，那段逻辑在领域层。
  把状态推导搬进 SQL 是拿地方便换内核完整性。
- **加行锁**：`node:sqlite` 是同步 API，`BEGIN IMMEDIATE` 已经在 `append` 里用了，
  但锁保护不到「读会话」这一步——读发生在事务之外。

## 后果

- 写路径的并发模型写死在「一个 server 进程是唯一写者」这个前提上。多写者要重新设计，
  这跟 `ADR` 之外的另一条决定（SQLite + 单写者）是同一件事的两面。
- 事件落盘延迟 = 该会话队列长度。单机会话里 delta 的队列深度是个位数，不影响观感。
- 新增一条回归测试（`apps/server/src/events.test.ts`）：一条用例证明排队后一条不丢，
  另一条用例证明不排队时确实会丢。后者是前者的理由，也是当初没人发现的原因。
