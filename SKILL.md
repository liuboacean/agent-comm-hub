---
name: agent-comm-hub
description: "本地多智能体通信 Hub（MCP stdio / HTTP-SSE），提供消息、任务编排、共享记忆、进化引擎，暴露 58 个 MCP 工具 + Web 管理面板"
version: "3.0.22"
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

> 多智能体消息转发与上下文共享中间件 — **v3.0.22**

让两个或多个独立 AI 智能体之间实现**实时双向通信**和**上下文自动同步**。基于 MCP 协议 + stdio 模式，消息本地持久化，延迟 < 50ms。

## 架构概览

```
┌──────────────┐         ┌──────────────────────────────┐         ┌──────────────┐
│   Agent A    │  SSE    │   Agent Communication Hub    │  SSE    │   Agent B    │
│  (Hermes)    │◄───────►│  (stdio)                    │◄───────►│ (WorkBuddy)  │
│              │  MCP    │                              │  MCP    │              │
└──────────────┘◄───────►│  SQLite WAL + 30 表          │◄───────►└──────────────┘
                          │  58 MCP 工具 + RBAC 权限     │
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

### 58 个 MCP 工具（当前版本）

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

## 技术依赖

**Hub 服务器**：
- Node.js 18+
- @modelcontextprotocol/sdk ^1.10.2（支持 StdioServerTransport）
- express ^4.19
- better-sqlite3 ^11.9
- zod ^3.23

**Python 客户端（零外部依赖）**：
- Python 3.9+（纯标准库：http.client / json / asyncio）
