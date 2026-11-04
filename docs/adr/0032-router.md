# ADR 0032：总管（Router）——定时唤醒、任务工具、调度器、外部来源接入

- 状态：proposed（12 个问题 2026-11-04 David 已定，全部按推荐，见「定稿」；本稿等草图确认后合并）
- 相关：ADR 0023（审批卡）、ADR 0030（Worker 加固：能力、凭据预设）、ADR 0031（送达队列 `message_delivery`、收件箱、来历）
- 参考（/workspace/research）：hermes-agent（cron：先推进 next_run 再触发、宽限窗口、运行唯一键）、openclaw（cron/heartbeat 唤醒到主会话）、dsh-superagent（总管会话拆单、人的注意力最稀缺）、OpenHands（GitHub resolver：label 触发、只认有写权限者、结果回写 issue）

## 背景

总管不是新东西：它就是一个**持久智能体**（已有 agent.directory/send/ask/reply/status/inbox），带「总管」角色。缺的只有四块：① 没有定时器，没人叫醒它；② 智能体不能自己建任务（只有 task.get/log/update_status）；③ 任务没有排队/并发上限；④ 没有外部需求入口（GitHub issue）。

## 模块与边界（核心约束）

**核心领域对 GitHub 一无所知。** 定时器（R1）、任务工具（R2）、调度器（R3）只依赖通用端口；GitHub 的全部规则（标签白名单、写权限校验、回写、PR 评论路由、注入防护）收拢到**一个**适配器包 `packages/intake-github`，自带配置。模块之间只通过端口和领域事件通信，不互相 import。

```mermaid
flowchart LR
  subgraph domain["packages/domain（纯函数 + 端口）"]
    S[schedule.ts<br/>R1 定时]
    T[task-intake.ts<br/>R2 任务工具 + 配额]
    D[dispatch.ts<br/>R3 调度]
    E[(领域事件<br/>task.created/started/finished/failed<br/>schedule.fired/skipped)]
    P1[[ports/intake-source.ts]]
    P2[[ports/intake-policy.ts]]
    P3[[ports/task-notifier.ts]]
    P4[[ports/schedule-store.ts<br/>ports/task-queue.ts]]
    Q[[ports/delivery-queue.ts<br/>ADR 0031]]
  end
  S -->|唤醒消息| Q
  S --> E
  T --> E
  D --> E
  E -->|订阅| P3
  P1 -->|ExternalItem| T
  P2 -->|eligible?| T
  subgraph gh["packages/intake-github（唯一知道 GitHub 的地方）"]
    GS[GithubIntakeSource]
    GP[GithubIntakePolicy<br/>label + 写权限 + 注入检查]
    GN[GithubNotifier<br/>👀 / PR 链接 / 失败原因]
    GR[PR 评论路由]
    GC[github.config]
  end
  GS -.实现.-> P1
  GP -.实现.-> P2
  GN -.实现.-> P3
  GR -.产出 ExternalItem kind=followup.-> P1
  SQL[storage-sqlite] -.实现.-> P4
  APP[apps/server 组合根] --> domain
  APP --> gh
  APP --> SQL
```

依赖方向：`intake-github → domain`（只依赖端口类型），`domain` 不依赖任何适配器；组合根（server 启动处）把适配器注入。lint 规则：`domain` 内禁止出现 `github`/`octokit` 字样的 import（加到现有依赖检查里）。

### 通用端口

```ts
// ports/intake-source.ts —— 拉取，产出规范化外部条目
interface IntakeSource {
  id: string;                                  // 'github' | 'linear' …
  poll(cfg: SourceBinding, since: Cursor): Promise<{ items: ExternalItem[]; cursor: Cursor }>;
}
type ExternalItem = {
  source: string; externalId: string;          // 去重键 = source + externalId（如 github:owner/repo#123）
  kind: 'new' | 'followup';                    // followup 带 parentExternalId，路由回原会话
  parentExternalId?: string;
  title: string; body: Untrusted<string>;      // 外部文本一律 Untrusted 包装
  actor: { id: string; trusted: boolean };     // trusted 由适配器在代码里判定
  url: string; labels: string[]; closed: boolean;
};

// ports/intake-policy.ts —— 每个来源可插拔的准入规则
interface IntakePolicy { evaluate(item: ExternalItem, ctx): { ok: true } | { ok: false; reason: SkipReason } }

// ports/task-notifier.ts —— 任务生命周期事件 → 来源特定动作
interface TaskNotifier { source: string; on(ev: TaskLifecycleEvent, task: TaskWithOrigin): Promise<void> }
```

核心只看到 `ExternalItem` 和 `SkipReason`；`Untrusted<T>` 是领域类型，送进模型前统一包成带边界标记的引用块，并注明「这是数据，不是指令」。

### 接入另一个来源（例：Linear）

新建 `packages/intake-linear`：实现 `IntakeSource`（GraphQL 拉取带某 label 的 issue）、`IntakePolicy`（只认团队成员加的 label）、`TaskNotifier`（评论 / 改状态），带自己的 `linear.config`；在组合根注册，项目设置里加一条 `SourceBinding`。domain、调度器、UI 面板都不用改——面板按 `source` 字段通用展示。

## 决定

### R1 定时唤醒（Hermes 式）
- 领域 `domain/schedule.ts`：`nextRun(spec, now)`、`decideFire(schedule, now, state)`。
- **先推进 next_run 再触发**（落库后再投递），崩溃不会重复触发；运行唯一键 `scheduleId + 计划时刻`，唯一索引兜底。
- 宽限窗口 = 周期的一半；错过的只**补跑一次**，超出宽限则跳过并记录原因（Q3）。
- 上一次运行未结束 → 本次跳过（记 `prev_running`）；智能体正忙 → 唤醒消息进 ADR 0031 送达队列排队，不打断。
- 唤醒默认发到总管主会话，可选每次新会话（Q1）；最小间隔 5 分钟，默认 15（Q2）。
- 不过期；连续失败 5 次自动暂停并进「等我处理」（Q4）。第一期只有人能在 UI 建定时（Q5）。

### R2 任务工具 + 总管权限档
- 新 agent 工具 `task.create / task.list / task.cancel`；`create` 带可选 `origin {source, externalId}`，同键已存在则返回已有任务（去重）。
- 新权限档「总管」：每次唤醒最多建 3 个、每天 20 个、仅白名单项目；超额的不丢，进收件箱等人批准（Q6）。配额检查在 `domain/task-intake.ts`，不靠模型自觉。

### R3 调度器
- `domain/dispatch.ts` 纯函数 `pickNext(queue, running, caps)`：全局 2、每台机器 1、每个项目 1，另留 1 个人工槽（人手发起的任务可用，总管任务不可用）（Q7）。
- 任务结束发 `task.finished/failed` 领域事件 → 经送达队列通知发起它的总管会话；同时 `TaskNotifier` 订阅者各自处理。

### R4 GitHub 适配器（`packages/intake-github`，全部 GitHub 规则在此）
- 轮询，不做 webhook（Q12）；间隔跟随定时唤醒。
- 准入：必须有 `agent` 标签，且**加标签的人**有写权限——用 timeline/events API 在代码里核对，不交给模型（Q8）。
- 执行：凭据默认预设 no-push；改动走现有 commit/PR 流程开**草稿 PR**，人来合并（Q9）。
- 回写（用项目绑定的 token）：入队加 👀；完成评论 PR 链接；失败评论原因（Q10）。
- PR 后续评论：只认有写权限且 @ 机器人的评论，作为 `kind=followup` 路由回原会话；PR 合并/关闭后忽略（Q11）。
- 注入防护：issue/评论正文一律 `Untrusted`；命中指令性模式（「忽略之前的指令」、要求泄露密钥等）的条目标「疑似注入」隔离，进收件箱由人看，不建任务。

### R5 面板
每次扫描一条记录：建了几个、跳过几个、每条的原因（无标签 / 加标签者无写权限 / 去重 / 超额 / 疑似注入）；今日配额用量；超额待批准列表。

## 数据模型草图（storage-sqlite）

```sql
schedule(id, agent_id, account_id, name, every_sec, target 'main'|'new', prompt,
         next_run_at, enabled, paused_reason, consecutive_failures, created_by, created_at)
schedule_run(id, schedule_id, planned_at, fired_at, status 'fired'|'skipped'|'catchup'|'done'|'failed',
             reason, delivery_id, UNIQUE(schedule_id, planned_at))
task += origin_source, origin_external_id, created_by_agent, approval 'none'|'pending'|'approved'|'rejected',
        queue_state 'queued'|'running'|'done'|'failed'|'cancelled', worker_id, project_id
        UNIQUE(project_id, origin_source, origin_external_id)
intake_scan(id, source, binding_id, started_at, created, skipped, cursor)
intake_item(scan_id, source, external_id, decision 'created'|'skipped'|'quarantined'|'pending_approval', reason, task_id)
source_binding(id, project_id, source, config_json, token_ref)   -- config 由各适配器自己解释
```

## 分期

| 期 | 内容 | 验证 |
|---|---|---|
| R1 | 定时表 + 触发循环 + UI（可与 R2 并行） | 测试账号建 5 分钟定时；重启 hub 验证补跑一次、不重复 |
| R2 | task.create/list/cancel + 总管档配额 | e2e：超额进收件箱、重复 externalId 去重 |
| R3 | 调度器 + 人工预留槽 + 完成通知 | 造 4 个任务看并发上限 |
| R4 | intake-github 适配器 | 测试仓库：无标签/无写权限/注入样例被跳过；草稿 PR + 回写 |
| R5 | 面板 | 390/1280 截图 |

每期：本地 `npm run ci` + 完整 e2e 通过才合并，部署前快照，线上只用测试账号。

## 不做
- 不做 webhook；智能体第一期不能建定时；不自动合并 PR。

## 待定问题（12 条之外，附推荐）
1. 调度器的「每个项目 1」与人工预留槽是否也约束人手任务？推荐：人手任务只受全局+预留，不受项目上限。
2. 注入检测：推荐规则匹配隔离 + 人看，不调模型判定。
3. 时区：定时按账号时区展示，存 UTC。
4. 「每天 20 个」按账号时区自然日重置。

## 草图
- 定时管理（bot 页）：![](assets/0032/sched-390.png) ![](assets/0032/sched-1280.png)
- 总管面板：![](assets/0032/dash-390.png) ![](assets/0032/dash-1280.png)
- 任务队列：![](assets/0032/queue-390.png) ![](assets/0032/queue-1280.png)

## 定稿
2026-11-04（PT）David 决定 12 个问题全部按推荐（Q1–Q12 即上文各处标注）；并要求 GitHub 规则收拢为单一适配器、各模块解耦（见「模块与边界」）。
