# 工作台本轮验收

建议先用隔离的本地 Hub 和测试项目验收，不要在真实工作目录试删目录、推送分支或创建 PR。部署环境可以使用同一清单；先确认页面版本已包含本轮改动。

本地验收时，先运行 `npm run build`，再启动一个使用独立数据目录的 Hub：

```bash
data=$(mktemp -d /tmp/opencode/ah-accept-data.XXXXXX)
roots=$(mktemp -d /tmp/opencode/ah-accept-work.XXXXXX)
mkdir "$data/home"
env -i PATH="$PATH" HOME="$data/home" HUB_HOST=127.0.0.1 HUB_PORT=8060 HUB_DATA_DIR="$data" \
  HUB_TEST_ACCOUNT_FILE="$data/test-account" HUB_SPAWN_WORKER=1 WORKER_ROOTS="$roots" \
  HUB_MAIL_PROVIDER=log HUB_MAIL_OUTBOX="$data/outbox.jsonl" \
  node apps/server/src/main.ts
```

浏览器打开 `http://127.0.0.1:8060`，用本次数据目录里的 `test-account` 登录。把示例目录或仓库放到本次 `roots` 下。此命令不继承生产配置和模型凭据；需要实际运行 Agent 的条目，先在隔离实例配置测试运行时。停止服务用 Ctrl+C，不会影响生产 Hub。

| 场景 | 操作 | 应看到 |
| --- | --- | --- |
| 手机项目列表 | 打开项目，使用包含一条会话和多条未启动任务的项目；从已有会话点入，再返回 | 已有会话优先，可直接进入；无会话任务明确显示「暂无会话」，仍可打开任务或显式启动；返回保留列表上下文 |
| 手动刷新 | 分别打开项目列表、首页「等我处理」、机器、资产待审；在另一页面改变数据后点刷新 | 数据重新读取，刷新期间有反馈；不清空当前列表、筛选或滚动位置；失败可重试 |
| 开始会话 | 项目中选定一台可用机器，保留另一台不可用机器，再切换机器、目录或模型 | 主区域不被未选机器的警告刷屏；未完成配置不能开始；只显示当前启动尝试的仓库准备状态 |
| 文件夹选择 | 分别在开始会话和登记工作目录时打开；用手机下钻、返回、输入完整路径、新建子目录，再确认 | 打开不弹键盘；进入目录不等于选定；底部确认回填真实目录；读不到目录或机器断开时不能误选旧数据 |
| 派工交接 | 有条件时，用已授权的项目会话发送指向该派工完整 SHA 的结构化交接；用派工所有者查看 | 可信交接显示正文和候选 SHA；「只进收件箱」不代表已运行或测试通过；不可见或查不全不显示成「未交付」 |
| 派工人工验收 | 在真实执行工作树提交 A，确认 A 的验收，再提交 B 并刷新 | 保留 A 的验收记录，B 不继承；无法读取 HEAD 时不能确认；验收不改变任务状态，也不推送、不开 PR |
| 手机 diff | 在有两个以上变更文件的会话打开差异，切换比较范围，选文件，再返回文件列表 | 列表和正文各自可读；返回保留所选范围和文件；比较范围含义清楚，敏感文件不展示正文 |

审批和问询回归：提交处理请求后只显示已提交，收到运行时持久事件才显示决策；结果未知不是失败，也不自动重发。问询和测试报告若适配器未上报，不凭普通消息制造记录。

## 本地验证记录

- `npm run check`、`npm run typecheck`、`npm run typecheck:web` 和 `git diff --check` 均通过。`npm test`：3,049 项通过、8 项跳过、无失败。
- 在独立数据目录运行 `node --test e2e/workspace-delegation.test.ts`：5 项通过。使用真实的本地 Hub、独立 Worker 进程和 Git，验证可信交接、精确 SHA 及旧验收不继承；不是生产或真实 GitHub 验收。
- 目录选择与启动调用方使用独立端口和数据目录运行：

  ```bash
  run=$(mktemp -d /tmp/opencode/ah-workbench-browser.XXXXXX)
  E2E_PORT=8064 E2E_DATA_DIR="$run/data" SHOTS_DIR="$run/shots" \
    npx --no-install playwright test e2e/derive-mobile.spec.ts e2e/picker.spec.ts \
    e2e/workspace-create.spec.ts e2e/session-links.spec.ts e2e/canvas.spec.ts \
    e2e/hub-dialog.spec.ts --output="$run/results" --reporter=list
  ```

  退出状态 0，17 项通过；需要 `E2E_HUB_MODEL` 的可选用例跳过。移动项目列表、刷新、审批与未知结果、派工验收及 diff 阅读另有定向浏览器用例通过。多机器就绪与不可用状态由测试夹具控制，不代表实际机器或上游模型可用。
