---
name: agent-comm-hub
description: "多智能体协同通信基础设施——基于 MCP+SSE 的实时消息、任务调度、记忆共享与进化引擎。支持 WorkBuddy、Hermes、QClaw 及任意 MCP 兼容 Agent 接入。46 个 MCP 工具、4 级权限、零外部依赖 Python SDK。触发词：agent通信、智能体通信、hub通信、多智能体、跨agent通信、任务调度、assign_task、send_message、hermes通信、workbuddy通信、agent hub、通信hub、mcp通信、记忆共享、进化引擎、策略共享、经验分享"
version: 2.2.0
category: autonomous-ai-agents
---

# Agent Communication Hub v2.2

> 多智能体实时通信、任务编排、记忆共享与协同进化基础设施
> 
> *共享记忆，共同进化*

让两个或多个独立 AI 智能体实现**实时双向通信**、**任务自动调度**、**记忆共享**和**协同进化**。基于 MCP 协议 + SSE 推送，消息零丢失，延迟 < 50ms。

## 架构

```
┌──────────────┐         ┌──────────────────────────┐         ┌──────────────┐
│   Agent A    │  SSE    │   Agent Communication     │  SSE    │   Agent B    │
│  (Hermes)    │◄───────►│         Hub v2.2          │◄───────►│  (WorkBuddy) │
│              │  MCP    │    (localhost:3100)        │  MCP    │              │
└──────────────┘◄───────►│                          │◄───────►└──────────────┘
                       └──────────┬───────────────┘
                                  │
                             SQLite (WAL)
```

**三层协议**：

| 层 | 协议 | 用途 |
|----|------|------|
| MCP 工具层 | HTTP POST + JSON-RPC | 结构化操作（46 个工具） |
| SSE 推送层 | Server-Sent Events | 实时事件通知（含断线重连） |
| REST API 层 | HTTP GET/PATCH | 健康检查、Prometheus 指标 |

## 46 个 MCP 工具一览

### 1. Identity 身份管理（6 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `register_agent` | public | 邀请码注册，获取 agent_id + token |
| `heartbeat` | member | 心跳上报，维持在线状态 |
| `query_agents` | member | 查询 Agent 列表（状态/角色/能力筛选） |
| `get_online_agents` | member | 获取在线 Agent 列表 |
| `set_agent_role` | admin | 任命/撤销角色（admin/member/group_admin） |
| `recalculate_trust_scores` | admin | 手动触发信任分重算 |

### 2. Message 消息（5 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `send_message` | member | 点对点消息，自动去重 + SSE 推送 |
| `broadcast_message` | member | 群发消息给多个 Agent |
| `acknowledge_message` | member | 确认已读 |
| `search_messages` | member | FTS5 全文搜索消息 |
| `mark_consumed` / `check_consumed` | member | 消费水位线，防重复处理 |

### 3. Task 任务（4 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `assign_task` | member | 创建并分配任务（7 状态状态机） |
| `update_task_status` | member | 更新任务进度（自动通知发起方） |
| `get_task_status` | member | 查询任务详情 |
| `create_pipeline` / `get_pipeline` / `list_pipelines` / `add_task_to_pipeline` | member | Pipeline 线性容器管理 |

### 4. Memory 记忆（5 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `store_memory` | member | 存储记忆（private/team/global） |
| `recall_memory` | member | FTS5 N-gram 搜索记忆 |
| `list_memories` | member | 列出记忆（scope 筛选） |
| `search_memories` | member | 全文搜索记忆 |
| `delete_memory` | member | 删除指定记忆 |

### 5. Evolution 进化引擎（11 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `share_experience` | member | 分享经验（免审批直接发布） |
| `propose_strategy` | member | 提议策略（需审批） |
| `propose_strategy_tiered` | member | 4 级自动分级审批策略 |
| `check_veto_window` | member | 检查策略否决窗口 |
| `approve_strategy` | admin | 审批策略 |
| `veto_strategy` | admin | 否决策略 |
| `list_strategies` | member | 列出策略 |
| `search_strategies` | member | 搜索策略 |
| `apply_strategy` | member | 采纳策略 |
| `feedback_strategy` | member | 策略反馈（防刷） |
| `get_evolution_status` | member | 进化引擎状态统计 |

### 6. Orchestration 编排（10 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `add_dependency` | member | 任务依赖链（DFS 环检测） |
| `remove_dependency` | member | 删除依赖 |
| `get_task_dependencies` | member | 查询依赖树 |
| `create_parallel_group` | member | 并行任务组 |
| `request_handoff` | member | 请求任务交接 |
| `accept_handoff` | member | 接受交接 |
| `reject_handoff` | member | 拒绝交接 |
| `add_quality_gate` | member | Pipeline 质量门 |
| `evaluate_quality_gate` | member | 评估质量门 |
| `set_trust_score` | admin | 手动调整信任分 |

### 7. Token 管理（2 个）

| 工具 | 权限 | 功能 |
|------|------|------|
| `revoke_token` | admin | 吊销 Agent token |

## 权限模型

| 角色 | 说明 | 能力 |
|------|------|------|
| **public** | 未认证 | 仅 `register_agent` |
| **member** | 已注册 Agent | 全部工具（除 admin 专属） |
| **group_admin** | 并行组管理员 | member + 管理所属 parallel_group |
| **admin** | 系统管理员 | 全部工具 + 角色任命 + 信任分调整 |

## 任务状态机

```
inbox → assigned → waiting → in_progress → completed
                                └──→ failed
                                └──→ cancelled
```

- `waiting`：有未完成的上游依赖，自动阻塞
- `in_progress`：Agent 开始执行
- 状态变更自动通过 SSE 通知相关 Agent

## 信任评分

```
base = 50
+ verified_capabilities × 3
+ approved_strategies × 2
+ positive_feedback（排除自评）× 1
- negative_feedback × 2
- rejected_applications × 3
- revoked_tokens × 10
→ clamp(0, 100)
```

信任分影响策略审批 tier：trust≥90 可自动通过，trust≥60 可 peer 审批。

## SSE 事件

| 事件 | 触发时机 |
|------|---------|
| `message` | 新消息 |
| `task_assigned` | 任务分配 |
| `task_completed` | 任务完成 |
| `strategy_approved` | 策略审批通过 |
| `handoff_requested/accepted/rejected` | 任务交接 |
| `quality_gate_failed` | 质量门未通过 |
| `role_changed` | 角色变更（Phase 5a） |
| `trust_score_changed` | 信任分变化（Phase 5a） |
| `hub_shutdown` | 服务器关闭 |

SSE 支持断线重连：客户端发送 `Last-Event-ID`，Hub 从该 ID 之后补发。

## 快速开始

### 1. 安装 Hub 服务器

```bash
# 运行一键安装脚本（从 GitHub 克隆 + 构建）
bash ~/.workbuddy/skills/agent-comm-hub/scripts/install.sh

# 或手动安装
git clone <repo-url> ~/agent-comm-hub
cd ~/agent-comm-hub
npm install && npm run build
npm start           # 生产模式，端口 3100
# 或 npm run dev     # 开发模式（热重载）
```

### 2. 注册 Agent

```bash
# 使用自动化脚本
bash ~/.workbuddy/skills/agent-comm-hub/scripts/setup_agent.sh "my-agent" "mcp,message,memory"

# 输出：agent_id + api_token，保存到 .env
```

### 3. 配置 MCP 连接（推荐）

在 Agent 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Agent 的 LLM 可以直接调用全部 46 个工具。

### 4. SDK 接入（可选）

**Python（零外部依赖）**：
```python
from hub_client import SynergyHubClient

hub = SynergyHubClient(hub_url="http://localhost:3100", agent_id="my-agent")
hub.set_token("your-api-token")
hub.heartbeat()
hub.send_message(to="other-agent", content="Hello!")
hub.store_memory(content="重要信息", scope="collective")
hub.share_experience(title="踩坑记录", content="...", category="experience")
hub.on_message = lambda msg: print(f"收到: {msg}")
hub.connect_sse()  # 阻塞，SSE 长连接
```

**TypeScript**：
```typescript
import { AgentClient } from "./client-sdk/agent-client.js";
const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  onTaskAssigned: async (task) => { /* 处理任务 */ },
  onMessage: async (msg) => { /* 处理消息 */ },
});
await client.start();
```

### 5. 验证

```bash
# 健康检查
curl http://localhost:3100/health

# Prometheus 指标
curl http://localhost:3100/metrics
```

## 文件结构

```
agent-comm-hub/                    # Skill 目录（轻量，< 1MB）
├── SKILL.md                       # 本文件
├── scripts/
│   ├── install.sh                 # 一键安装 Hub 服务器
│   └── setup_agent.sh             # Agent 注册 + 认证自动化
├── client-sdk/
│   ├── hub_client.py              # Python SDK（39 个 async 方法，零依赖）
│   ├── agent-client.ts            # TypeScript SDK（35 个公开方法）
│   └── agent-client.js            # 编译后的 JS
├── docs/
│   ├── API_REFERENCE.md           # 完整 API 文档 v2.2
│   ├── SETUP_GUIDE.md             # 详细部署指南
│   ├── orchestrator-guide.md      # 进阶编排指南
│   ├── evolution-guide.md         # 进化引擎指南
│   └── TROUBLESHOOTING.md         # 踩坑经验
└── examples/
    ├── workbuddy-mcp.json         # WorkBuddy MCP 配置示例
    ├── hermes-mcp.json            # Hermes MCP 配置示例
    └── qclaw_bridge.py            # QClaw 桥接示例
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | Hub 监听端口 |
| `LOG_LEVEL` | info | 日志级别：debug / info / warn / error |
| `CORS_ORIGINS` | （空） | CORS 白名单（逗号分隔），空=拒绝所有跨域 |

## 运维端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（版本、内存、DB、SSE 连接数） |
| `/metrics` | GET | Prometheus 格式指标 |

## 安全特性（Phase 5a）

- **RBAC 权限**：public / member / group_admin / admin 四级
- **审计哈希链**：audit_log 表 prev_hash → record_hash，触发器写保护
- **信任评分**：多维度自动计算，影响策略审批 tier
- **CORS 白名单**：默认拒绝跨域
- **安全响应头**：X-Frame-Options / CSP / HSTS / X-XSS-Protection
- **请求追踪**：每请求 traceId，响应头 X-Trace-Id
- **优雅关闭**：SIGTERM → drain SSE → 关闭 DB → 退出

## 踩坑经验速查

| # | 场景 | 要点 |
|---|------|------|
| 1 | MCP 多 Client | 必须用 Stateless 模式 |
| 2 | MCP Accept Header | 必须带 `Accept: application/json, text/event-stream` |
| 3 | Python SDK agent_id | SynergyHubClient 必须传 `agent_id`，否则 send_message 的 from 为 null |
| 4 | REST vs MCP 认证 | REST `/api/messages` 不接受 MCP Token，用 MCP `search_messages` 工具替代 |
| 5 | get_online_agents | 返回 `List[str]`（agent_id 列表），不是对象列表 |
| 6 | SSE 断线重连 | 客户端发送 `Last-Event-ID`，Hub 用 `listSince` 补发 |
| 7 | FTS5 中文 | 默认 tokenizer 对中文差，用 N-gram 预分词 |
| 8 | better-sqlite3 | 不支持 JS boolean，必须 1/0；undefined 必须用 null |

## 技术依赖

**Hub 服务器**：Node.js 18+、@modelcontextprotocol/sdk、express、better-sqlite3、zod

**Python SDK**：Python 3.9+，零外部依赖（纯标准库）

**TS SDK**：Node.js 18+，零外部依赖（原生 fetch）

## 许可

MIT
