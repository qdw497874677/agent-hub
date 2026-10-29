# 9. 会话页就是对话：思考进 journal，工具结果带输出

Status: accepted

## 背景

会话页原来是「卡片放大 + 右侧检查器」：看得到 agent 说了什么，看不到它想了什么、命令跑出了什么、
文件改成了什么。线上还出现过「发了一句话，会话安静地结束」——agent 回了 `stopReason: error`
（opencode-go 的 key 过期，401），映射层把它当成正常结束吞掉了。

## 决定

1. `SessionEvent` 加第八个变体 `thinking { delta }`：Pi 的 `thinking_delta`、ACP 的
   `agent_thought_chunk` 都映射到它。卡片不画它，对话页画成可折叠的「思考过程」。
2. `tool_result` 加可选的 `output`：命令输出、读到的内容、ACP 的 diff 块。进 journal 前截到
   `TOOL_OUTPUT_LIMIT`（16k 字符），并写明还有多少没保存——journal 不是日志仓库。
3. agent 以错误收尾（`stopReason: error`）时，会话记为 `ended(failed)` 并带中文原因，对话里直接显示。
4. 打开对话页时拉整段历史（`GET /events`），不只靠画布投影的最后 24 条——一段思考就有上百个 delta。
5. 旧检查器的内容进「详情」抽屉；分叉、换个地方继续进「更多」和消息菜单。显示设置（工具、思考、
   默认展开、紧凑）存在浏览器里，按账号区分。

## 后果

- 老的 journal 没有 thinking 和 output，照常显示，只是工具卡里没有输出。
- 新增变体对旧前端是未知 kind；前后端一起发布。
