---
name: agent-comm-hub
description: "本地多智能体通信 Hub（MCP stdio / HTTP-SSE），提供消息、任务编排、共享记忆、进化引擎，暴露 59 个 MCP 工具 + Web 管理面板"
version: "3.0.33"
category: autonomous-ai-agents
triggers:
  - "agent-comm-hub"
  - "AgentCommHub"
  - "ACH"
  - "agent-comm"
  - "agent_comm_hub"
  - "通信hub"
  - "消息hub"
  - "workbuddy"
  - "QClaw"
  - "send_message"
  - "assign_task"
---

# Agent Communication Hub

> 多智能体消息转发与上下文共享中间件 — **v3.0.33**

让两个或多个独立 AI 智能体之间实现**实时双向通信**和**上下文自动同步**。基于 MCP 协议 + stdio 模式，消息本地持久化，延迟 < 50ms。

## 架构概览

```
┌──────────────┐         ┌──────────────────────────────┐         ┌──────────────┐
│   Agent A    │  SSE    │   Agent Communication Hub    │  SSE    │   Agent B    │
│  (Hermes)    │◄───────►│  (stdio)                    │◄───────►│ (WorkBuddy)  │
│              │  MCP    │                              │  MCP    │              │
└──────────────┘◄───────►│  SQLite WAL + 30 表          │◄───────►└──────────────┘
                          │  59 MCP 工具 + RBAC 权限     │
                          │  上下文暂存 + 建议闭环       │
                          └──────────────┬──────────────┘
                                         │
                                    SQLite (WAL)
```

**三层协议**：

| 层 | 协议 | 用途 | 延迟 |
|----|------|------|------|
| MCP 工具层 | stdio JSON-RPC | 结构化操作（发消息、分配任务、查状态） | <50ms |
| SSE 推送层 | Server-Sent Events | 实时事件通知（新消息、新任务、建议确认） | <50ms |

## 快速上手 (5 分钟)

从零到完成第一次 Agent 间通信的编号流程：

### Step 1: 确认 Hub 运行状态

确认 Agent Communication Hub 服务器正在运行。如果通过 stdio 模式接入，检查 MCP 配置是否正确加载：

```
调用: get_online_agents()
期望: 返回在线 Agent 列表（至少含自己）
失败: Hub 未运行 → 先启动 Hub 服务器
```

**[检查点] 用户确认**：如果 Hub 未运行，询问用户是否要启动 Hub 服务器。

### Step 2: 注册或确认身份

检查自己是否已在 Hub 注册，如果没有则注册：

```
1. 调用: query_agents(status='all') → 查看所有 Agent
2. 如果自己的 Agent ID 不在列表中
   → register_agent(invite_code, name, capabilities)
3. 如果已注册 → 记下自己的 agent_id 供后续使用
```

**[检查点] 用户确认**：注册新 Agent 需要 invite_code，先问用户是否有可用的邀请码。

### Step 3: 维持在线状态

启动心跳维持在线，确保能接收实时消息推送：

```
调用: heartbeat(agent_id='你的ID')
频率: 每 30 秒一次（超过 90 秒无心跳则自动标记为离线）
```

### Step 4: 检查未读消息

上线后第一时间检查是否有离线期间缓存的消息：

```
1. 调用: search_messages(query='你的ID', limit=20)
2. 筛选 status='unread' 的消息
3. 按时间顺序处理，先 acknowledge_message 确认收到，再回复
```

**[检查点] 用户确认**：找到未读消息后，逐条向用户摘要汇报，请用户确认如何处理。

### Step 5: 发送第一条消息

向另一个 Agent 发送消息，验证双向通信：

```
调用: send_message(from='你的ID', to='目标AgentID', content='通信链路确认畅通')
检查返回: delivered_realtime — true=对方在线, false=对方离线
```

**[检查点] 用户确认**：发送前向用户确认消息内容和目标 Agent。broadcast_message 必须逐条确认。

### 完整闭环示例

```
场景：Hub 在线 → 检查 WorkBuddy 是否有未读消息 → 处理并回复

1. get_online_agents()                    # 确认自己和对方在线
2. search_messages(limit=10)              # 查最近消息
3. acknowledge_message(msg_id, agent_id)  # 标记已读
4. send_message(to='workbuddy', content='已收到，正在处理')  # 回复
5. mark_consumed(resource=msg_id, action='replied')  # 消费水位线
```

## 核心能力

### 59 个 MCP 工具（当前版本）

#### Identity 身份 (6)

| 工具 | 功能 |
|------|------|
| `register_agent` | 注册新 Agent，需提供 HUB_AUTH_TOKEN 认证 |
| `heartbeat` | Agent 心跳上报，维持在线状态，每 3 次连续心跳记录 +1 |
| `query_agents` | 查询 Agent 列表，支持状态/角色筛选 |
| `get_online_agents` | 获取当前在线 Agent 列表 |

#### Message 消息 (5)

| 工具 | 功能 |
|------|------|
| `send_message` | Agent 间点对点消息，支持 Markdown，自动去重（sha256） |
| `broadcast_message` | (需逐条确认后发送) |
| `acknowledge_message` | 确认已读消息，防止重复出现 |
| `search_messages` | 全文搜索消息历史 |
| `batch_acknowledge_messages` | 批量确认消息（1-500 条/次），用于清理消息积压 |

#### File 文件 (3)

| 工具 | 功能 |
|------|------|
| `upload_file` | 发送文件附件（Base64，10MB 限制），关联到消息 |
| `download_file` | 接收附件，返回 Base64 编码内容 |
| `list_attachments` | 列出附件，支持按消息/Agent 筛选 |

#### Task 任务 (3)

| 工具 | 功能 |
|------|------|
| `assign_task` | 创建并分配任务，支持上下文传递 |
| `update_task_status` | 更新任务状态（inbox→assigned→in_progress→completed/failed） |
| `get_task_status` | 查询任务详情，含依赖、Pipeline、交接信息 |

#### Context 上下文暂存 (5)

| 工具 | 功能 |
|------|------|
| `store_memory` | 临时暂存当前任务参考信息 |
| `recall_memory` | 检索已暂存的上下文 |
| `list_memories` | 列出当前 Agent 的暂存条目 |
| `delete_memory` | 删除暂存条目（仅 creator） |
| `search_memories` | 检索当前 Agent 的暂存内容 |

#### 经验记录

经验记录和策略管理需特定权限配置。

#### 任务协同

| 工具 | 功能 |
|------|------|
| `add_dependency` | 添加任务依赖关系（依赖检查） |
| `remove_dependency` | 删除任务依赖关系 |
| `get_task_dependencies` | 查询任务上下游依赖 |
| `create_parallel_group` | 创建并行任务组（2-10 个任务） |
| `request_handoff` | 请求任务交接 |
| `accept_handoff` | 接受任务交接 |
| `reject_handoff` | 拒绝任务交接（含理由） |
| `add_quality_gate` | 在 Pipeline 中添加质量门 |
| `evaluate_quality_gate` | 评估质量门（passed/failed） |
| `recalculate_trust_scores` | 按调度执行分数维护 |
| `create_pipeline` | 创建 Pipeline 流水线 |
| `get_pipeline` | 查询 Pipeline 详情 |
| `list_pipelines` | 列出 Pipeline |
| `add_task_to_pipeline` | 向 Pipeline 添加任务 |

#### 运维工具 (4)

| 工具 | 功能 |
|------|------|
| `get_db_stats` | 数据库统计信息（表行数、大小、Agent 数等） |
| `archive_data` | 数据维护工具 |
| （其余 2 个内部工具） | 权限验证与控制 |
| （其余 2 个内部工具） | 权限验证与控制 |

#### 消费水位线 (2)

| 工具 | 功能 |
|------|------|
| `mark_consumed` | 标记任务/消息为已消费，防止重复处理 |
| `check_consumed` | 查询资源是否已被消费 |

#### 事件订阅 (1)

| 工具 | 功能 |
|------|------|
| `subscribe_events` | 管理**当前 Agent 自身**的 SSE 事件订阅（两级过滤）：`subscribe` 订阅、`unsubscribe` 退订（默认参数清空全部）、`list` 列出。仅可管理自身订阅 |

> **订阅直通语义**：Agent 订阅后，Hub 在 `broadcastToAll` 广播时按订阅规则剪枝——仅投递命中订阅的事件；**未订阅的 Agent 维持现状全投（零回归）**。点对点 `pushToAgent` 不受影响。
> **L1**（P1）：`event_type` 为 `'*'`/空 = 任意类型，否则须相等；`topic_filter` 为空 = 不限主题，非空 = 对事件 payload JSON 串做 `includes`。
> **L2**（P2-B，可选参数 `condition_json`）：结构化条件 JSON 数组，**全部 AND 命中才投递**；空/不传 = 仅 L1（P1 语义零回归）。纯数据 DSL、零 LLM、无 `eval`。
> 条件示例：`[{"path":"task.priority","op":"eq","value":"high"}]`
> - `path`：dot 路径（字母数字/下划线/连字符，≤5 段），禁止 `__proto__`/`constructor`/`prototype`。
> - `op`：`eq` / `ne` / `in`（value 为标量数组）/ `contains`（字符串或数组）/ `gt` / `lt`（数值比较）/ `exists`（无需 value）。
> - `value`：仅标量 string/number/boolean/null；上限 10 条件 / 1024 字符。非法条件**直接拒绝**（fail-closed，不静默放宽）。
> - 多条订阅规则是 **OR**（任一命中即投递）；同一 L1 下不同 L2 条件可并存（唯一约束含 `condition_json`）。
> - 退订：不传 `condition_json` 且 `event_type`/`topic_filter` 均为默认（`*`/空）→ 清空全部；显式传 `condition_json` → 四元组精确删除单条。

> 所有工具内置 try-catch + 3 次指数退避重试（100ms → 200ms → 400ms）。v2.4.0 统一错误格式：`HubError` 错误码 + `mcpError()`/`mcpFail()` 标准返回。`check_consumed` 查询失败时降级返回 `consumed=false`（不阻塞业务）。

### 任务状态机

```
inbox → assigned → [waiting] → in_progress → completed / failed / cancelled
```

## 用户确认检查点

以下操作必须在执行前暂停，向用户摘要说明并等待确认：

| # | 操作 | 检查点说明 | 风险 |
|---|------|-----------|------|
| 1 | **broadcast_message** | 广播消息会发送给多个 Agent，逐条确认内容和接收列表 | 高 |
| 2 | **assign_task** | 分配任务前确认：描述是否清晰、目标 Agent 是否合适、Priority 正确 | 中 |
| 3 | **batch_acknowledge_messages** | 批量确认会一次性标记多条消息为已处理，确认不会遗漏重要信息 | 中 |
| 4 | **create_pipeline** | 创建流水线前确认任务顺序、质量门设置、参与 Agent | 中 |
| 5 | **add_quality_gate** | 质量门失败会阻塞后续任务，确认评估标准合理 | 高 |
| 6 | **request_handoff** | 交接任务前确认目标 Agent 有能力接手、理由充分 | 中 |
| 7 | **archive_data** | 归档操作会移动数据到归档表，确认归档范围和天数 | 高 |
| 8 | **store_memory(scope='group')** | 写入组内共享记忆前确认内容适当，不会泄露敏感信息 | 中 |
| 9 | **propose_strategy** | 提议策略前确认内容准确、分类正确、有实际价值 | 低 |
| 10 | **reject_handoff** | 拒绝交接需提供理由，确认不会导致任务阻塞 | 中 |

> **规则**：LLM 遇到上表操作时，先向用户输出摘要说明，明确询问"是否继续？"，得到肯定答复后再执行。用户可随时跳过检查点。

## 数据隔离与安全边界

| 边界 | 实现方式 |
|------|---------|
| **接收方校验** | `send_message`/`assign_task` 中的 `to_agent` 必须为已注册 Agent，未注册 Agent 被拒绝 |
| **Per-Agent 数据隔离** | 每个 Agent 仅可见自身消息、任务和暂存条目；跨 Agent 查询受 4 级权限控制 |
| **暂存内容保护** | `store_memory` 创建的条目仅 creator 可检索和删除，不会自动暴露给其他 Agent |
| **经验记录审批** | `share_experience` 提交的记录需经 `full` 权限确认后才对其他 Agent 可见 |

## 接入配置（stdio 模式）

在 MCP 配置文件中添加 Hub 为 stdio 服务器，提供 `HUB_AUTH_TOKEN` 环境变量进行认证。Hub 通过 stdio 传输 MCP 协议，Agent 的 LLM 可直接调用 Hub 工具。**stdio 模式必须设置 HUB_AUTH_TOKEN，缺失将拒绝启动。**

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "command": "node",
      "args": ["<hub-install-path>/stdio.js"],
      "env": {
        "HUB_AUTH_TOKEN": "your-connection-key"
      }
    }
  }
}
```

## 资源索引

此 skill 目录下已有 Hub 完整源码，可直接参考：

### 本地源文件

| 文件 | 用途 |
|------|------|
| `src/server.ts` | 服务端入口，Express + MCP/SSE 双通道 |
| `src/tools.ts` | 全部 MCP 工具的 TypeScript 实现 |
| `src/db.ts` | SQLite WAL 数据库初始化与连接 |
| `src/identity.ts` | Agent 注册、认证、4 级权限控制 |
| `src/dedup.ts` | SHA256 消息去重实现 |
| `src/errors.ts` | HubError 统一错误码（v2.4.0+） |
| `src/stdio.ts` | Stdio 模式传输层 |
| `src/sse.ts` | SSE 推送通道 |
| `src/orchestrator.ts` | 任务编排、Pipeline、质量门 |
| `src/evolution.ts` | Evolution Engine：策略/经验/信任分 |
| `src/memory.ts` | 上下文暂存与管理 |
| `src/security.ts` | 安全验证、CORS、Token 管理 |
| `src/metrics.ts` | 统计指标收集 |
| `src/repo/` | 数据访问层（repository pattern） |
| `package.json` | Node.js 依赖与版本定义 |

### 参考链接

- GitHub 仓库: https://github.com/liuboacean/agent-comm-hub
- MCP 协议规范: https://spec.modelcontextprotocol.io

## 权限说明（4 级）

| 级别 | 说明 | 可用工具范围 |
|------|------|----------|
| **authenticated** | 已认证（HUB_AUTH_TOKEN） | register_agent（初始注册） |
| **member** | 已注册 Agent | 消息 `send_message`/`acknowledge_message` + 任务 `assign_task`/`get_task_status` |
| **group_manager** | 并行组管理 | 任务协同 + Pipeline 工具（不含暂存/经验） |
| **full** | 完整权限 | 全部工具（含运维与建议管理） |

> 部分管理类工具仅特定权限可调用，具体以实际角色配置为准。

> 初始分数 50，公式：`base(50) + verified_capabilities*3 + approved_strategies*2 + positive_feedback*1 - negative_feedback*2`，clamp(0,100)。

## 版本历史

### v3.0.24 — 宿主执行器闭环收口（HostExecutor 注入）
| 类别 | 内容 | 说明 |
|------|------|------|
| 宿主执行 | HostExecutor 契约 + 参考实现 | 新增 `client-sdk/adapters/host-executor.ts`（`LlmHostExecutor` / `HttpHostExecutor` / `defaultHostExecutor()`）；`AbstractHostTaskBridge` 可注入 `executor` |
| 闭环 | 消灭 setTimeout 占位 | WorkBuddy / Hermes 桥 `runTask()` 委托 `this.executor.execute()`，任务到达即触发宿主真实能力 |

### v3.0.25 — 跨进程 SSE 桥接 + watcher 实时解析修复
| 类别 | 内容 | 说明 |
|------|------|------|
| 推送 | 跨进程 SSE 桥接（方案 B） | `pushToAgent` 在当前进程无目标 SSE 连接且配置 `SSE_BRIDGE_URL` 时，转发事件至桥接进程 `/internal/sse/push`，打通 stdio MCP 派单进程 → HTTP SSE 服务进程的实时送达 |
| 服务端 | 桥接接收端点 | `server.ts` 新增 `POST /internal/sse/push`（鉴权保护），由持有 SSE 连接的进程本地投递 |
| 客户端(watcher) | SSE 实时解析修复 | `hub_watcher.py` 由 `resp.read(4096)` 缓冲读改为逐行 `readline()`，消除低吞吐 SSE 流缓冲阻塞；修正事件分发（`payload.event` 取真实类型）与受保护 REST API 的 Bearer 鉴权头 |
| 效果 | 派单→自动执行闭环 | 接收方持有 SSE 长连接（如 WorkBuddy 本地 watcher）即可实时收到 `task_assigned` 并触发宿主自动化执行 |

### v3.0.25.1 — 数据库损坏恢复与运维加固（2026-09-29）
| 类别 | 内容 | 说明 |
|------|------|------|
| 事故 | comm_hub.db SQLITE_CORRUPT | 多进程共享 WAL（含 7 天僵尸进程持锁）阻止 checkpoint + 历史联调盘损未修，导致主库 btree 损坏、归档停摆(2026-07-23)、`get_online_agents` 空 |
| 恢复 | sqlite3 .recover 重建 | 主表零丢失（agents/strategies/tasks），仅坏页极少量丢失；`integrity_check=ok` |
| Bugfix | FTS 重建幂等化 | `rebuildStrategiesFts`/`rebuildFtsIndex` 改为「先 DELETE 再全量 INSERT」，根治 `constraint failed` 与索引漂移（孤儿行致 `search_memories` 搜不到内容） |
| 看门狗 | SQLite 结构完整性探针 | `scripts/cron_db_watchdog.sh` 新增 `quick_check` + `memories_fts` 行数漂移检查，每 10 分钟一次，仅告警（exit 6/7）不自动重启 |
| 安全 | 凭据泄露三件套 | `scripts/scan_leaked_credentials.py`（只读、sha256 命中库判定有效凭据）／`redact_leaked_credentials.py`（减害脱敏，默认 dry-run）／`rotate_token.py`（先发后撤可逆轮换，明文仅写 600 文件） |

### v3.0.33 — P2-B 确定性两级过滤（L1 类型/主题 + L2 结构化条件，零 LLM）

| 类别 | 内容 | 说明 |
|------|------|------|
| 背景 | DeepSeek「两级过滤」思想 | **只移植「分级」骨架，不移植 LLM 快判/慢判**（违背零 LLM 铁律）。L1 复用 P1 订阅剪枝，L2 为纯数据条件求值 |
| L2 DSL | `condition_json` 结构化条件数组 | dot path + `eq/ne/in/contains/gt/lt/exists`，全部 AND；value 仅标量；路径禁 `__proto__`/`constructor`；上限 10 条件/1024 字符；**无 eval、无正则、零 LLM**；非法条件 fail-closed 拒绝 |
| 两级语义 | `subscriptionMatches` | L1 与 L2 同时命中该规则才投递；多条规则 OR；`condition_json` 为空 = 纯 L1（P1 零回归）；未订阅 Agent 仍全投；点对点 `pushToAgent` 不受影响 |
| 表结构 | `subscriptions` 新增 `condition_json` 列 | 唯一约束由三列扩为四列（同 L1 不同 L2 可并存）。SQLite 无法 ALTER 表级约束，故幂等重建表 + 复制旧数据（旧规则 `condition_json=''`）；二次加载不重复重建 |
| 工具 | `subscribe_events` 新增可选 `condition_json` | 服务端 `normalizeConditionJson` 校验 + 规范化（固定键序，语义相同幂等去重），非法返回 `mcpFail`；精确退订支持四元组；仍仅可管理自身订阅 |
| 测试 | `p2-b-filter.test.ts` 21 项 + `p2-b-migration.test.ts` 1 项 | L1 零回归 / 各操作符 / dot path / 多条件 AND / 多规则 OR / L1∧L2 / 9 类非法条件 / 规范化幂等 / 精确退订 / 越权 / 与 P0 组合零回归；迁移专项用独立子进程加载真实编译产物验证老库升级 + 二次幂等 |
| 限制 | 仅作用于广播剪枝 | L2 不改变点对点投递、不触碰 `event_log` 至少一次语义；条件按字段取值（非字符串子串），`gt/lt` 仅数值且非数值 fail-closed |

### v3.0.32 — P2-A 事件驱动（outbox-lite 事务化发射 + 到期驱动，默认 opt-in）

| 类别 | 内容 | 说明 |
|------|------|------|
| 背景 | 借鉴 DeepSeek Super-Agent「事件驱动」 | **明确不移植** LLM 两级过滤 / 投机执行 / Router-Worker 重写（违背 Hub「零 LLM + 确定性 + WORM 审计」铁律）；仅采纳确定性事件驱动 |
| A1 outbox-lite | `src/event-driven.ts` 的 `withEvents(business, events)` | 复用 `event_log.delivered=0` 作待发队列，**不新建表**；业务写与事件落库放【同一事务】，事务提交后才同步 `dispatchPersistedEvent(seq)`（成功写 `delivered=1`），回滚则事件一并回滚、绝不外发（无幽灵通知）。`pushToAgent` 契约与现有调用方零改动 |
| A2 到期驱动 | `computeNextDeadline` + 单 timer | 从 tasks 表算全局最早到期 `MIN(due_at, updated_at+stuckMs)`，单个 `setTimeout`（unref）到点触发 `runEventDrivenScan()`（事务化释放 + 审计 + 通知）；任务状态变更由 `notifyScheduleChanged()` 重算；启动即从 DB 重建 |
| A2 断线宽限期 | `onClientConnected/Disconnected` | SSE 断线启动 90s 宽限期 timer（重连即取消，不误判），到期仍未重连才 `releaseTasksForOfflineAgent`（幂等）；`gracefulShutdown` 在 drain 前停止调度器，避免关机误释放 |
| 兜底 | Watchdog / 心跳保留 | 事件驱动启用时 Watchdog 降为 30min 低频兜底（防重启丢 timer）；**默认 `HUB_EVENT_DRIVEN=0` 关闭**，关闭时所有挂钩 no-op，行为与 v3.0.31 完全一致，一键回滚 |
| 限制 | 本地 SSE 投递 | 事件驱动路径【同步】投递、不走批处理窗口；跨进程桥接（`SSE_BRIDGE_URL`）与 P1 批处理仍走原 `pushToAgent` 路径；无本地连接时事件留 `delivered=0` 靠重连 replay 兜底（至少一次） |
| 测试 | `tests/integration/p2-event-driven.test.ts` | 14 项跨模块集成：事务提交必达 / 回滚无幽灵事件 / 条件事件 / dispatch 幂等 / 离线补投 / D1 同步契约、MIN 到期计算 / 启动重建 / 准点释放 / 重算 / 宽限期重连 / 到期释放 / stop 清理 / 默认关闭零回归 |

### v3.0.31 — P1 批处理改为 opt-in（默认关闭，保住 D1 同步可靠性契约）

- **行为变更**：`HUB_SSE_BATCH_MS` 默认从 `120` 改为 `0`（关闭），批处理变为 **opt-in**。
- **动机**：P1 默认 120ms 窗口异步冲刷破坏了 D1 可靠性契约回归测试（`sse-replay.test.ts` 断言同步 `delivered=1`）；用户拍板优先严格同步可靠性，批处理仅作可选优化。
- 设为 `HUB_SSE_BATCH_MS=120`（或任意 >0）即恢复窗口合并；桥接转发与重连补发始终立即投递 + 至少一次，不受影响。
- `sse.ts` 环境变量改为调用时读取（原已修复），生产默认 0；`sse-replay.test.ts` 文件级仍显式关批处理锁定 D1 契约 + 批处理专测（显式开 50ms 验证）。

### v3.0.30 — P1 订阅直通 + 事件批处理（借鉴 DeepSeek Super-Agent「订阅 + 批处理」，零回归）
| 类别 | 内容 | 说明 |
|------|------|------|
| 背景 | 对照 DeepSeek《Super-agent 设计探索》 | 明确**不移植** LLM 慢判/投机执行/Router 重写（违背 Hub「零 LLM + 确定性 + WORM 审计」铁律）；仅采纳「订阅直通 + 批处理」两项确定性增强 |
| 订阅表 | `subscriptions` 表（db.ts） | 字段 `id/agent_id/event_type/topic_filter/condition_json/created_at`，唯一约束 `(agent_id, event_type, topic_filter, condition_json)` 保证幂等且允许同 L1 不同 L2 并存；P1 老库由幂等重建迁移升级（旧规则 `condition_json=''`，语义不变）；`subscribeEvent`/`unsubscribeEvent`/`getSubscriptions`/`getAllSubscriptions` + 纯函数 `parseConditions`/`evaluateConditions`/`subscriptionMatches` |
| 剪枝 | `broadcastToAll` 订阅剪枝（sse.ts） | 仅「有订阅且规则未命中」的 Agent 被跳过；未订阅 Agent 维持全投；点对点 `pushToAgent` 不受影响。内存缓存 `subsCache` 仅含已订阅 Agent，`reloadSubsCache()` 启动 + 订阅变更热刷新 |
| 批处理 | SSE 事件批处理窗口（sse.ts） | 实时投递路径新增 `enqueueForDelivery`/`flushAgentBuffer`：实现为 **opt-in**，默认 `HUB_SSE_BATCH_MS=0`（关闭，逐条立即投递，保住 D1 严格同步可靠性契约 `delivered=1`）；设为 >0（如 120ms）启用窗口 / 25 条上限突发合并；桥接转发与重连补发始终立即投递 + 至少一次 |
| 工具 | `subscribe_events`（member 权限） | 单一工具支持 subscribe/unsubscribe/list 三动作，handler 内强制 `agentId === ctx.agentId`（仅能管理自身订阅）；已登记进 fail-closed 权限矩阵 |
| 安全 | 零回归 + 可逆 | 剪枝只作用于广播、不触碰点对点；订阅写审计无关、删除即恢复全投 |

### v3.0.29 — P0 运行时 Watchdog 自治自愈（借鉴 DeepSeek Super-Agent，重发修正 latest 指针）
| 类别 | 内容 | 说明 |
|------|------|------|
| 背景 | 借鉴 DeepSeek《Super-agent 设计探索》「外部 Watchdog + 自治自愈 + 持久化」三思想 | 直击 9-29 事故根因：任务卡死 / Agent 掉线后任务变孤儿 |
| 离线释放 | `releaseTasksForOfflineAgent` 注入 `startHeartbeatMonitor` 的 `onAgentOffline` 回调 | Agent 离线即将其 `assigned`/`in_progress` 任务退回收件箱（清空 `assigned_to`），逐条写 `audit_log`，并 `pushToAgent` 通知任务创建者 |
| 卡死巡检 | `runWatchdogScan` + `startWatchdogScheduler`（默认每 5 分钟，`WATCHDOG_INTERVAL_MS` 可覆盖） | 扫描 `status IN ('assigned','in_progress')` 且 `updated_at` 超阈值（默认 30 分钟，`WATCHDOG_STUCK_MS` 可覆盖）无进展，或 `due_at` 已过期的任务，退回收件箱 + 通知创建者 |
| DB 层 | `findTasksByAgentStatus` / `findStuckTasks` / `releaseTaskToInbox`（db.ts 纯 SQL，无循环依赖） | `releaseTaskToInbox` 仅对 `assigned`/`in_progress` 生效（已完成/已取消不动），幂等；全部动作入审计日志，安全可逆 |
| 哲学 | human-in-loop + WORM 审计 | 自愈仅做「退回 + 通知」，重派决策留给任务创建者，契合既有 human-in-loop 安全边界 |

### v3.0.x（安全加固）
| 类别 | 内容 | 说明 |
|------|------|------|
| 权限模型 | fail-closed 权限矩阵 | `checkPermission` 未注册工具默认拒绝；`TOOL_PERMISSIONS` 全量登记，杜绝 fail-open |
| 认证 | stdio 强制认证 | 缺失 `HUB_AUTH_TOKEN` 直接 `process.exit(1)`，移除 glama-ci admin 兜底 |
| 角色护栏 | admin 校验 | 9 个 admin 类工具 handler 首行 `requireAdmin(ctx)` |
| HTTP 中间件 | 分级放行 | `/health`、`/metrics` 仅内网/loopback 或 token 放行；`/dashboard`、`/api/*` 需 token + admin |
| 审计 | WORM 不可篡改 | 审计日志仅归档不删源，保留 `no_delete` / `no_modify` 触发器 |
| 数据归属 | 域隔离 | `search_messages` 强制本人收发域；记忆统计按 agent 隔离，admin 才指定他人 |
| 对象级授权 | assertOwns 中间件 | message/attachment/task 三族工具插入 `assertOwns()` 归属校验（HUB_2004）；`/health` 收敛（删除内网 IP/路径泄露） |
| sender 校验 | send_message 身份守卫 | broadcast_message + send_message 均强制 `from === ctx.agentId`，杜绝身份伪造 |
| memory 降级 | search_memories 补 agent_id 过滤 | FTS5 离线回退 SQL 增加 `agent_id = ?`，防止越权泄漏 |
| 内部函数 | setAgentRole/updateAgentTrustScore 加 admin 校验 | 底层函数不再信任 `operatorId`，显式查库验证 admin 身份 |
| SQL 修复 | registerCapability 占位符 | 6→7 个占位符匹配实际 7 个字段值，修复运行时崩溃 |
| triggers 收窄 | SKILL.md 触发词 | 移除 `Hub`/`通信`/`消息` 过宽泛触发词，改用具体标识

### v2.4.0
| Phase | 内容 | 变更 |
|-------|------|------|
| **A** | tools.ts 拆分 | 2687 行 → 8 模块 + 30 行入口 + utils.ts |
| **B** | 单元测试 | 100 用例，role-control >= 70% / dedup branches>=60, functions>=70 / utils 100% |
| **C** | CI/CD | GitHub Actions：typecheck + test + coverage 3 Jobs |
| **D** | 类型健壮 | any 归零 + HubError 统一错误码 + MCP 返回格式标准化 |

## 踩坑经验速查

| # | 场景 | 要点 |
|---|------|------|
| 1 | MCP 多 Client | 必须用 Stateless 模式，Stateful 只允许一个 Client |
| 2 | MCP Accept Header | 必须带 `Accept: application/json, text/event-stream` |
| 3 | MCP 响应格式 | SDK 返回 SSE 格式（`data: {...}`），不是纯 JSON |
| 4 | ESM 兼容 | 不能用 `require()`，用 `import()` 动态导入 |
| 5 | UTF-8 块读取 | httpx `resp.read(1)` 会截断多字节字符，用 `read(4096)` |
| 6 | SSE 心跳 | 10 秒间隔，服务端发 `: ping` |
| 7 | MCP != SSE | MCP 是工具调用通道（Agent→Hub），SSE 是推送通道（Hub→Agent） |
| 8 | 离线补发 | 消息/任务存 SQLite，上线后 SSE 自动批量推送 |
| 9 | stdio 模式 | 所有日志走 stderr，stdout 保留给 JSON-RPC |
| 10 | better-sqlite3 boolean | 绑定参数必须用 1/0，不能用 true/false |
| 11 | HubError 错误码 | v2.4.0 统一用 mcpError()/mcpFail()，不要手动构造错误响应 |

## 安全配置

| 配置项 | 说明 |
|--------|------|
| `HUB_AUTH_TOKEN` | stdio / REST 模式认证 Token，所有 Agent 接入必须提供，用于身份认证与消息完整性校验 |
| 4 级权限模型 | authenticated → member → group_manager → full，逐级授权 |
| CORS 白名单 | 默认拒绝跨域，通过 `CORS_LIST` 显式配置允许的来源 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_AUTH_TOKEN` | — | stdio / REST 认证 Token（必填） |
| `DB_PATH` | ./comm_hub.db | SQLite 数据库路径 |
| `LOG_LEVEL` | info | 日志级别：debug / info / warn / error |
| `CORS_LIST` | (空) | CORS 白名单（逗号分隔），空=拒绝所有跨域 |
| `HUB_SSE_BATCH_MS` | 0 | SSE 实时投递批处理窗口（毫秒）；**默认 0 = 关闭（opt-in）**，突发事件逐条立即投递（D1 严格同步可靠性契约默认路径）。设为 >0（如 120）启用窗口合并优化，突发事件在该窗口内合并写入 |
| `HUB_SSE_BATCH_MAX` | 25 | 单 Agent 批处理缓冲上限，达到即立即冲刷（防止突发撑爆内存 / 延迟过高） |
| `HUB_EVENT_DRIVEN` | 0 | **P2-A 事件驱动总开关**；设 `1` 启用到期驱动 + 断线宽限期。默认 0 = 关闭（opt-in），关闭时所有挂钩 no-op、零回归，设 0 即一键回滚 |
| `HUB_EVENT_GRACE_MS` | 90000 | SSE 断线宽限期（毫秒）；到期仍未重连才释放该 Agent 的孤儿任务，重连即取消 |
| `HUB_EVENT_MAX_DELAY_MS` | 1800000 | 到期 timer 单次最大延迟（毫秒）；超长到期会被 clamp 并周期性重算，防 timer 过长 |
| `WATCHDOG_STUCK_MS` | 1800000 | 任务卡死阈值（毫秒）；同时用于到期计算 `updated_at + stuckMs` |
| `WATCHDOG_INTERVAL_MS` | 300000 / 1800000 | Watchdog 定时巡检间隔；事件驱动关闭时 5min，启用时降为 30min 低频兜底。显式设置始终优先 |

## 技术依赖

**Hub 服务器**：
- Node.js 18+
- @modelcontextprotocol/sdk ^1.10.2（支持 StdioServerTransport）
- express ^4.19
- better-sqlite3 ^11.9
- zod ^3.23

**Python 客户端（零外部依赖）**：
- Python 3.9+（纯标准库：http.client / json / asyncio）
