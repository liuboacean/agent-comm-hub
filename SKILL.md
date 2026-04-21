---
name: agent-comm-hub
description: "多智能体协同通信基础设施——基于 MCP+SSE 的实时消息、任务调度与在线感知。支持 WorkBuddy、Hermes 及任意 MCP 兼容 Agent 接入。触发词：agent通信、智能体通信、hub通信、多智能体、跨agent通信、任务调度hub、assign_task、send_message、hermes通信、workbuddy通信、agent hub、通信hub、mcp通信"
version: 1.1.0
category: autonomous-ai-agents
---

# Agent Communication Hub

> 🔌 多智能体实时通信与任务调度基础设施

让两个或多个独立 AI 智能体之间实现**实时双向通信**、**任务自动调度**和**在线状态感知**。基于 MCP 协议 + SSE 推送，消息零丢失，延迟 < 2 秒。

## 架构概览

```
┌──────────────┐         ┌──────────────────────┐         ┌──────────────┐
│   Agent A    │  SSE    │  Agent Communication  │  SSE    │   Agent B    │
│  (Hermes)    │◄───────►│        Hub            │◄───────►│  (WorkBuddy) │
│              │  MCP    │    (port 3100)        │  MCP    │              │
└──────────────┘◄───────►│                      │◄───────►└──────────────┘
                       └──────────┬───────────┘
                                  │
                             SQLite (WAL)
```

**三层协议**：

| 层 | 协议 | 用途 | 延迟 |
|----|------|------|------|
| MCP 工具层 | HTTP POST + JSON-RPC | 结构化操作（发消息、分配任务、查状态） | <50ms |
| SSE 推送层 | Server-Sent Events | 实时事件通知（新消息、新任务） | <50ms |
| REST API 层 | HTTP GET/PATCH | 轻量查询（供脚本和自动化使用） | <50ms |

## 核心能力

### 9 个 MCP 工具

**通信与任务调度（6 个）**：

| 工具 | 功能 |
|------|------|
| `send_message` | Agent 间即时消息，在线实时送达，离线持久化 |
| `assign_task` | 分配 AI 任务给对方 Agent，对方自动接收执行 |
| `update_task_status` | 汇报任务进度，自动通知发起方 |
| `get_task_status` | 查询任务状态和结果 |
| `broadcast_message` | 广播消息给多个 Agent |
| `get_online_agents` | 查询在线 Agent 列表 |

**消费水位线（3 个）**：

| 工具 | 功能 |
|------|------|
| `acknowledge_message` | 标记 Hub 消息为已处理，防止重复出现在待处理列表 |
| `mark_consumed` | 记录 Agent 已处理某资源（文件/信号），防止重复处理 |
| `check_consumed` | 查询某资源是否已被处理过，处理前先查再处理 |

> 所有工具内置 try-catch + 3 次指数退避重试（100ms → 200ms → 400ms）。`check_consumed` 查询失败时降级返回 `consumed=false`（不阻塞业务）。

### 5 个 REST API

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/tasks` | GET | 查询任务列表（支持 agent_id + status 过滤） |
| `/api/messages` | GET | 查询消息列表 |
| `/api/tasks/:id/status` | PATCH | 更新任务状态（自动通知发起方） |
| `/api/messages/:id/status` | PATCH | 标记消息已读 |
| `/api/consumed` | GET | 查询消费水位线记录（支持 agent_id + resource 过滤） |

### 任务状态机

```
pending → in_progress → completed
                └──→ failed
```

## 快速开始

### 1. 启动 Hub 服务器

```bash
cd hub-server/
npm install
npm run dev    # 开发模式（热重载）
# 或
npm run build && npm start   # 生产模式
```

Hub 启动后监听端口 3100，输出：

```
╔════════════════════════════════════════╗
║   Agent Communication Hub  v1.0.0     ║
║   Stateless Mode — Multi-Client       ║
╚════════════════════════════════════════╝
```

### 2. 配置 Agent 接入

**方式 A：MCP 配置（推荐）**

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

Agent 的 LLM 可以直接调用 `assign_task`、`send_message` 等工具。

**方式 B：SDK 接入**

TypeScript Agent：
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

Python Agent：
```python
import asyncio
from hub_client import HubClient

client = HubClient(
    agent_id="my-agent",
    hub_url="http://localhost:3100",
    on_task_assigned=lambda task: print(f"收到任务: {task['description']}"),
)
await client.start()
```

### 3. WorkBuddy 侧守护（可选）

启动 SSE 守护进程实现秒级响应：

```bash
# 安装 launchd 服务
cp workbuddy-side/launchd/com.workbuddy.hub-watcher.plist ~/Library/LaunchAgents/
cp workbuddy-side/launchd/com.workbuddy.hub-task-runner.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-watcher.plist
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-task-runner.plist
```

## 文件结构

```
agent-comm-hub/
├── SKILL.md                          # 本文件
├── README.md                         # 完整文档（GitHub 级别）
├── LICENSE                           # MIT 许可证
│
├── hub-server/                       # Hub 服务器（TypeScript）
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts                 # 主入口：Express + MCP + SSE
│   │   ├── db.ts                     # SQLite 持久化层（WAL 模式）
│   │   ├── sse.ts                    # SSE 连接管理
│   │   └── tools.ts                  # 9 个 MCP 工具定义
│   ├── client-sdk/
│   │   └── agent-client.ts           # 通用 TypeScript 客户端 SDK
│   └── scripts/
│       └── install.sh                # 一键安装脚本
│
├── workbuddy-side/                   # WorkBuddy 侧组件
│   ├── scripts/
│   │   ├── hub_watcher.py            # SSE 守护进程（launchd）
│   │   └── hub_task_runner.py        # 任务通知触发器（launchd）
│   └── launchd/
│       ├── com.workbuddy.hub-watcher.plist
│       └── com.workbuddy.hub-task-runner.plist
│
├── hermes-side/                      # Hermes 侧组件
│   ├── scripts/
│   │   ├── hub_client.py             # Python 客户端（SSE + MCP）
│   │   └── hub_integration.py        # Hermes 集成入口
│   └── config/
│       └── mcp-server-example.json   # MCP 配置示例
│
└── docs/
    ├── SETUP_GUIDE.md                # 详细配置指南
    ├── API_REFERENCE.md              # API 参考
    └── TROUBLESHOOTING.md            # 常见问题与踩坑经验
```

## 踩坑经验速查

| # | 场景 | 要点 |
|---|------|------|
| 1 | MCP 多 Client | 必须用 Stateless 模式，Stateful 只允许一个 Client |
| 2 | MCP Accept Header | 必须带 `Accept: application/json, text/event-stream` |
| 3 | MCP 响应格式 | SDK 返回 SSE 格式（`data: {...}`），不是纯 JSON |
| 4 | ESM 兼容 | 不能用 `require()`，用 `import()` 动态导入 |
| 5 | UTF-8 块读取 | httpx `resp.read(1)` 会截断多字节字符，用 `read(4096)` |
| 6 | SSE 心跳 | 10 秒间隔，服务端发 `: ping` |
| 7 | MCP ≠ SSE | MCP 是工具调用通道（Agent→Hub），SSE 是推送通道（Hub→Agent） |
| 8 | 离线补发 | 消息/任务存 SQLite，上线后 SSE 自动批量推送 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | Hub 监听端口 |
| `HUB_URL` | http://localhost:3100 | Hub 地址（客户端用） |
| `HUB_AGENT_ID` | workbuddy | 本 Agent 的 ID |
| `SIGNAL_DIR` | ~/.hermes/shared/signals | 信号文件目录 |
| `WB_TRIGGER_DIR` | ~/.workbuddy/hub-tasks | WorkBuddy 触发文件目录 |

## 技术依赖

**Hub 服务器**：
- Node.js 18+
- @modelcontextprotocol/sdk ^1.10
- express ^4.19
- better-sqlite3 ^11.9
- zod ^3.23

**Python 客户端**：
- Python 3.9+
- httpx（异步 HTTP + SSE）

**WorkBuddy 守护**：
- Python 3.9+（无第三方依赖，纯标准库）
