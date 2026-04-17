# Agent Communication Hub

> 🔌 多 AI 智能体实时通信与任务调度基础设施

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.9+-3776AB?logo=python)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-2025--03--26-FF6B35)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

让两个或多个独立 AI 智能体之间实现**实时双向通信**、**任务自动调度**和**在线状态感知**。

基于 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) + SSE，消息零丢失，端到端延迟 < 2 秒。

---

## 特性

- **📡 实时双向通信** — 基于 SSE 推送，Agent 间消息 < 50ms 送达
- **📋 任务自动调度** — 分配任务给对方 Agent，自动接收并执行
- **👁 在线状态感知** — 实时知道哪些 Agent 在线
- **💾 离线不丢失** — 所有消息和任务持久化到 SQLite，上线自动补发
- **🔌 MCP 原生** — 基于 MCP 协议，Agent 像调用本地工具一样调用远程能力
- **📦 零依赖客户端** — WorkBuddy 侧 Python 守护进程仅用标准库，无需 pip install
- **🔄 多 Agent 扩展** — 架构支持任意数量的 Agent 接入

## 架构

```
┌──────────────┐         ┌──────────────────────┐         ┌──────────────┐
│   Agent A    │  SSE    │  Agent Communication  │  SSE    │   Agent B    │
│  (Hermes)    │◄───────►│        Hub            │◄───────►│  (WorkBuddy) │
│              │  MCP    │    (port 3100)        │  MCP    │              │
└──────┬───────┘◄───────►│                      │◄───────►└──────┬───────┘
       │                  └──────────┬───────────┘               │
  hub_client.py              SQLite DB                   launchd
  (Python httpx)            (WAL 模式)                  hub_watcher
                                                          hub_task_runner
```

### 三层协议

| 层 | 协议 | 用途 |
|----|------|------|
| **MCP 工具层** | HTTP POST + JSON-RPC | 结构化操作（发消息、分配任务、查状态） |
| **SSE 推送层** | Server-Sent Events | 实时事件通知（新消息、新任务、上线/离线） |
| **REST API 层** | HTTP GET/PATCH | 轻量查询（供脚本和自动化使用） |

### 为什么用 MCP 协议

MCP 是 AI Agent 的标准通信协议。Agent 可以像调用本地工具一样调用 Hub 的功能——无需额外的 SDK 学习成本，LLM 天然理解 MCP 工具的 schema。

### 为什么用 Stateless 模式

Hub 使用 MCP SDK 的 Stateless 模式：每个请求创建独立的 Server + Transport 实例，DB 和 SSE 管理器作为模块级单例共享。支持多个 Agent 客户端同时连接，不会出现 "Server already initialized" 错误。

## 快速开始

### 前置要求

- **Node.js** 18+ （Hub 服务器）
- **Python** 3.9+ （客户端脚本）
- **httpx** Python 包（Hermes 侧客户端，`pip install httpx`）

### 1. 启动 Hub

```bash
# 克隆仓库
git clone https://github.com/YOUR_USER/agent-comm-hub.git
cd agent-comm-hub/hub-server

# 安装依赖
npm install

# 启动（开发模式）
npm run dev

# 或生产模式
npm run build && npm start
```

Hub 启动后监听 `http://localhost:3100`：

```
╔════════════════════════════════════════╗
║   Agent Communication Hub  v1.0.0     ║
║   Stateless Mode — Multi-Client       ║
╠════════════════════════════════════════╣
║  SSE  订阅: GET  /events/{agent_id}   ║
║  MCP  工具: POST /mcp                 ║
║  健康检查: GET  /health               ║
║  监听端口: 3100                        ║
╚════════════════════════════════════════╝
```

### 2. 接入 Agent

#### 方式 A：MCP 配置（推荐，LLM 原生支持）

在 Agent 的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Agent 的 LLM 现在可以直接调用 6 个 MCP 工具：`assign_task`、`send_message`、`update_task_status`、`get_task_status`、`broadcast_message`、`get_online_agents`。

#### 方式 B：TypeScript SDK

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  onTaskAssigned: async (task) => {
    console.log(`收到任务: ${task.description}`);
    await client.updateTaskStatus(task.id, "in_progress", undefined, 5);
    const result = await doWork(task.description);
    await client.updateTaskStatus(task.id, "completed", result, 100);
  },
  onMessage: async (msg) => {
    console.log(`来自 ${msg.from_agent}: ${msg.content}`);
  },
});
await client.start();
```

#### 方式 C：Python SDK

```python
import asyncio
from hub_client import HubClient

async def on_task(task):
    print(f"收到任务: {task['description']}")
    await client.update_task_status(task['id'], "completed", "done!", 100)

client = HubClient(
    agent_id="my-agent",
    hub_url="http://localhost:3100",
    on_task_assigned=on_task,
)
await client.start()
```

### 3. WorkBuddy 侧守护（可选）

启动 SSE 守护进程实现秒级任务响应：

```bash
# 替换 WORKBUDDY_SKILL_DIR 为实际路径
SKILL_DIR="path/to/agent-comm-hub"

# 设置 launchd plist 中的路径
sed -i '' "s|WORKBUDDY_SKILL_DIR|$SKILL_DIR|g" \
  workbuddy-side/launchd/com.workbuddy.hub-watcher.plist \
  workbuddy-side/launchd/com.workbuddy.hub-task-runner.plist

# 安装服务
cp workbuddy-side/launchd/*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-watcher.plist
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-task-runner.plist
```

## API 参考

### MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `send_message` | `from`, `to`, `content`, `type?`, `metadata?` | 发送即时消息 |
| `assign_task` | `from`, `to`, `description`, `context?`, `priority?` | 分配 AI 任务 |
| `update_task_status` | `task_id`, `agent_id`, `status`, `result?`, `progress?` | 汇报任务进度 |
| `get_task_status` | `task_id` | 查询任务状态 |
| `broadcast_message` | `from`, `agent_ids`, `content`, `metadata?` | 广播消息 |
| `get_online_agents` | — | 查询在线 Agent |

### REST API

| 端点 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/health` | GET | — | 健康检查 |
| `/api/tasks` | GET | `agent_id`, `status?` | 查询任务列表 |
| `/api/messages` | GET | `agent_id`, `status?` | 查询消息列表 |
| `/api/tasks/:id/status` | PATCH | `status`, `result?`, `progress?` | 更新任务状态 |
| `/api/messages/:id/status` | PATCH | `status` | 标记消息已读 |

### SSE 端点

| 端点 | 说明 |
|------|------|
| `GET /events/:agent_id` | Agent 订阅事件流（长连接） |

推送的事件类型：

| 事件 | 说明 |
|------|------|
| `new_message` | 收到新消息 |
| `task_assigned` | 收到新任务 |
| `task_updated` | 任务状态更新 |
| `pending_messages` | 上线时补发积压消息 |

## 任务状态机

```
assign_task → pending → in_progress → completed
                            └──→ failed
```

- `pending`：任务已创建，等待接收方拾取
- `in_progress`：接收方正在执行（可多次更新进度）
- `completed`：任务完成
- `failed`：任务执行失败

## 三层保障架构（WorkBuddy 侧）

由于 WorkBuddy 运行在 IDE 内部，无法直接运行长驻进程，采用三层保障：

```
┌─────────────────────────────────────────────────────────┐
│  第一层：秒级通知（SSE 守护）                             │
│  Hub SSE → hub_watcher.py → 触发文件 → macOS 通知       │
│  延迟：< 5 秒                                           │
├─────────────────────────────────────────────────────────┤
│  第二层：当前会话消费（用户在线时）                        │
│  用户收到通知 → 在对话中确认 → Agent 执行 → 更新状态     │
│  延迟：用户回到对话时即时                                 │
├─────────────────────────────────────────────────────────┤
│  第三层：每小时兜底（自动化）                             │
│  WorkBuddy 自动化 → 查 Hub API → 执行 pending 任务      │
│  延迟：最长 1 小时                                       │
└─────────────────────────────────────────────────────────┘
```

## 文件结构

```
agent-comm-hub/
├── SKILL.md                          # WorkBuddy Skill 定义
├── README.md                         # 本文件
├── LICENSE                           # MIT 许可证
│
├── hub-server/                       # Hub 服务器
│   ├── package.json                  # Node.js 依赖
│   ├── tsconfig.json                 # TypeScript 配置
│   ├── src/
│   │   ├── server.ts                 # 主入口：Express + MCP + SSE
│   │   ├── db.ts                     # SQLite 持久化（WAL 模式）
│   │   ├── sse.ts                    # SSE 连接管理
│   │   └── tools.ts                  # 6 个 MCP 工具定义
│   ├── client-sdk/
│   │   └── agent-client.ts           # 通用 TypeScript 客户端 SDK
│   └── scripts/
│       └── install.sh                # 一键安装脚本
│
├── workbuddy-side/                   # WorkBuddy 侧组件
│   ├── scripts/
│   │   ├── hub_watcher.py            # SSE 守护（launchd）
│   │   └── hub_task_runner.py        # 通知触发器（launchd）
│   └── launchd/
│       ├── com.workbuddy.hub-watcher.plist
│       └── com.workbuddy.hub-task-runner.plist
│
├── hermes-side/                      # Hermes 侧组件
│   ├── scripts/
│   │   ├── hub_client.py             # Python 客户端（SSE + MCP）
│   │   └── hub_integration.py        # 集成入口（含任务执行逻辑）
│   └── config/
│       └── mcp-server-example.json   # MCP 配置示例
│
└── docs/
    ├── SETUP_GUIDE.md                # 详细配置指南
    ├── API_REFERENCE.md              # API 参考
    └── TROUBLESHOOTING.md            # 踩坑经验与常见问题
```

## 踩坑经验

### MCP 协议

1. **必须用 Stateless 模式** — Stateful 模式只允许一个 Client 初始化，多 Agent 场景直接崩
2. **Accept Header 不可省** — `Accept: application/json, text/event-stream`，否则 404
3. **响应是 SSE 格式** — `event: message\ndata: {...}\n\n`，需解析 `data:` 行
4. **ESM 兼容** — 不能 `require()`，用 `import()` 动态导入

### Python

5. **UTF-8 块读取** — `resp.read(1)` 逐字节会截断多字节字符，必须 `read(4096)`
6. **SSE 长连接保活** — 处理好超时和重连逻辑（指数退避）

### 系统集成

7. **launchd KeepAlive** — 进程崩溃自动重启，比 cron 更可靠
8. **automation_update 副作用** — 每次更新在 IDE 数据库创建新记录，需定期清理
9. **MCP ≠ SSE** — MCP 是工具调用通道（Agent→Hub），SSE 是推送通道（Hub→Agent），两者独立
10. **离线补发** — 消息/任务存 SQLite，上线后 SSE 自动批量推送

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | Hub 监听端口 |
| `HUB_URL` | http://localhost:3100 | Hub 地址（客户端用） |
| `HUB_AGENT_ID` | workbuddy | 本 Agent ID |
| `HUB_WATCHER_LOG` | INFO | 日志级别 |
| `SIGNAL_DIR` | ~/.hermes/shared/signals | 信号文件目录 |
| `WB_TRIGGER_DIR` | ~/.workbuddy/hub-tasks | 触发文件目录 |

## 技术栈

| 组件 | 技术 |
|------|------|
| Hub 服务器 | TypeScript + Express + MCP SDK + better-sqlite3 |
| TS 客户端 SDK | TypeScript + EventSource + fetch |
| Python 客户端 | Python 3.9+ + httpx (async) |
| WorkBuddy 守护 | Python 3.9+ 标准库（零依赖） |
| 进程管理 | macOS launchd (KeepAlive) |

## 许可证

[MIT](LICENSE)

## 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) — AI Agent 标准通信协议
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — 同步 SQLite 绑定
- [httpx](https://www.python-httpx.org/) — 现代 Python HTTP 客户端
