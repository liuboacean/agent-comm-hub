<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green?logo=node.js" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Python-3.9+-blue?logo=python" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/MCP_Protocol-1.0-orange?logo=robot" alt="MCP Protocol">
  <img src="https://img.shields.io/badge/DB_Split_Protection-v3-green?logo=shield" alt="三层防护">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-SDK-blue?logo=typescript" alt="TypeScript SDK">
  <img src="https://img.shields.io/badge/Python_SDK-Zero_Dependencies-brightgreen?logo=python" alt="Zero Dependencies">
  <a href="demo/index.html"><img src="https://img.shields.io/badge/Live_Demo-7f77dd?logo=github" alt="Live Demo"></a>
</p>

<h1 align="center">Agent Communication Hub</h1>

<p align="center">
  生产级<strong>多智能体通信基础设施</strong>——实时消息、任务调度、共享记忆、信任进化<br>
  基于 MCP + SSE 协议，53 个工具，零外部依赖
</p>

<p align="center">
  <a href="#readme">中文</a> | <a href="docs/README_EN.md">English</a>
</p>

---

## 它能解决什么问题？

多个 AI Agent（Claude Code、OpenClaw、WorkBuddy 等）天然是信息孤岛：

- 无法**互相通信**（需要脆弱的 webhook 或共享数据库）
- 无法**跨 Agent 调度任务**
- 无法**共享上下文**（超出单次 prompt）
- 无法**共同进化**（基于团队经验）

**Agent Communication Hub** 为每个 MCP 兼容的 Agent 提供共享神经中枢——消息总线、任务队列、记忆层和进化引擎，让 Agent 协同工作，而非各自为战。

---

## 三步上手

```bash
# 1. 启动 Hub
docker run -d -p 3100:3100 --name ach liuboacean/agent-comm-hub

# 2. 注册 Agent
python3 -c "from hub_client import SynergyHubClient; print(SynergyHubClient('http://localhost:3100').register('YOUR_INVITE_CODE'))"

# 3. 发消息
python3 -c "from hub_client import SynergyHubClient; c=SynergyHubClient('http://localhost:3100'); c.set_token('YOUR_TOKEN'); c.send_message(to='other-agent', content='Hello!')"
```

零配置文件，零外部服务，本地即用。

---

## 核心特性

| 类别 | 工具数 | 说明 |
|------|:-----:|------|
| 身份认证 | 6 | 注册、心跳、RBAC 角色权限、信任评分 |
| 消息通信 | 5 | P2P / 广播、FTS5 全文搜索、去重 |
| 任务调度 | 8 | 7 状态机、Pipeline、并行组、自动重试 |
| 共享记忆 | 5 | private / team / collective 三级作用域 |
| 编排协调 | 8 | 依赖链（DFS 环检测）、质检门、交接协议 |
| 进化引擎 | 12 | 经验共享、4 级策略审批、信任反馈闭环 |
| 安全审计 | 4 | Token 认证、4 级 RBAC、审计哈希链、CORS 白名单 |
| 文件传输 | 3 | 上传 / 下载 / 列表，Base64 10MB 限制 |
| 高可用防护 | 2 | DB 分裂自动检测 + 合并 + 看门狗自愈 |

**53 个 MCP 工具** · SQLite WAL（零消息丢失） · SSE 推送延迟 < 50ms

---

## 架构

```
┌──────────────┐          ┌──────────────────────────┐          ┌──────────────┐
│   Agent A     │   SSE    │    Agent Communication    │   SSE    │   Agent B    │
│  (Claude Code)│◄────────►│         Hub v2.4           │◄────────►│ (WorkBuddy)  │
│              │  MCP     │       localhost:3100       │  MCP     │              │
└──────────────┘◄─────────►│                          │◄─────────►└──────────────┘
                          │  ┌────────────────────┐  │
                          │  │ Identity / RBAC     │  │
                          │  │ Message / Broadcast │  │
                          │  │ Task Scheduler      │  │
                          │  │ Memory (3 scopes)   │  │
                          │  │ Evolution Engine    │  │
                          │  │ Orchestrator        │  │
                          │  └──────────┬───────────┘  │
                          └─────────────┼──────────────┘
                                        │
                                   SQLite (WAL)
```

任何 MCP 兼容的 Agent 都可以连接：Claude Code、OpenClaw、WorkBuddy、自定义 Agent 等。

---

## SDK 示例

### Python（零依赖）

```python
from hub_client import SynergyHubClient

hub = SynergyHubClient(hub_url="http://localhost:3100", agent_id="my-agent")
hub.set_token("your-api-token")

# 发消息
hub.send_message(to="other-agent", content="任务完成，交接。")

# 存储共享记忆
hub.store_memory(content="用户偏好 JSON 响应", scope="collective")

# 创建任务
task = hub.create_task(title="评审 PR #42", assignee="claude-code", priority=2)

# 共享经验
hub.share_experience(title="DB 锁超时修复方案", content="...", category="debug")

# 实时监听
hub.on_message = lambda msg: print(f"收到: {msg}")
hub.connect_sse()  # 阻塞式 SSE 长连接
```

### TypeScript（零外部依赖）

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  token: "your-api-token",
  onMessage: async (msg) => { /* 处理 */ },
  onTaskAssigned: async (task) => { /* 处理 */ },
});

await client.start();
await client.sendMessage({ to: "other-agent", content: "完成！" });
```

---

## 部署

### Docker（推荐）

```bash
docker run -d -p 3100:3100 --name ach liuboacean/agent-comm-hub
```

### Docker Compose（含 Prometheus + Grafana）

```bash
cd deploy && docker compose up -d
# Hub:       http://localhost:3100
# Grafana:   http://localhost:3000 (admin/admin)
# Prometheus: http://localhost:9090
```

### 源码安装

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install && npm run build

# 方式 A — 快速启动（开发）
npm start

# 方式 B — 生产启动（推荐，含 DB 一致性检测 + 看门狗自愈）
bash scripts/start_hub_server.sh
```

### 作为 Skill 安装

```bash
# ClawHub
clawhub install liuboacean/agent-comm-hub

# SkillHub（30+ 平台）
npx skills add liuboacean/agent-comm-hub
```

---

## MCP 配置

启动 Hub 后，将其添加到 Agent 的 MCP 配置中：

### 方式一：stdio（推荐）

> 注意：显示设置 `DB_PATH` 环境变量可防止 Node 版本切换导致的多 DB 分裂问题

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "command": "node",
      "args": ["<hub-install-path>/dist/src/stdio.js"],
      "env": {
        "HUB_AUTH_TOKEN": "your-connection-key",
        "DB_PATH": "/path/to/comm_hub.db"
      }
    }
  }
}
```

### 方式二：HTTP + SSE

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

配置完成后，Agent 的 LLM 可以直接通过自然语言调用全部 53 个工具。

---

## 安全

| 特性 | 说明 |
|------|------|
| **RBAC** | 4 级：public → member → group_admin → admin |
| **Token 认证** | SHA-256 哈希存储，原始 token 不落库 |
| **审计哈希链** | `prev_hash → record_hash`，DB 触发器保证完整性 |
| **信任评分** | 自动计算，影响策略审批等级 |
| **CORS** | 白名单制，默认拒绝 |
| **安全头** | X-Frame-Options、CSP、HSTS、X-XSS-Protection |
| **请求追踪** | 每个请求附带 traceId + 响应头 |

---

## 项目结构

```
agent-comm-hub/
├── src/                         # Hub 服务端源码（TypeScript）
│   ├── server.ts                # Express + SSE + MCP 入口
│   ├── stdio.ts                 # stdio MCP 传输入口
│   ├── db.ts                    # SQLite WAL Schema + 查询
│   ├── identity.ts              # 注册、心跳、RBAC
│   ├── memory.ts                # 三级作用域记忆 + FTS5
│   ├── task.ts                  # 7 状态任务调度器
│   ├── orchestrator.ts          # 依赖链、Pipeline
│   ├── evolution.ts             # 策略引擎、信任评分
│   └── security.ts              # 认证、Token、RBAC、审计
├── client-sdk/
│   ├── hub_client.py            # Python SDK（零依赖，68 方法）
│   ├── agent-client.ts          # TypeScript SDK（35 公共方法）
│   └── package.json             # npm 发布配置
├── deploy/
│   ├── docker-compose.yml       # Prometheus + Grafana 可观测性
│   └── prometheus.yml           # 指标采集配置
├── docs/
│   ├── API_REFERENCE.md         # 53 工具完整参考
│   ├── advanced-orchestration-guide.md
│   ├── evolution-engine-guide.md
│   └── hermes-integration-guide.md
├── scripts/
│   ├── install.sh                  # Hub 服务安装脚本
│   ├── test-e2e.sh                 # 端到端测试套件
│   ├── start_hub_server.sh         # 生产启动脚本（含 DB 一致性检测）
│   ├── check_db_consistency.sh     # DB 分裂检测 + 自动合并（启动 / 看门狗共用）
│   └── cron_db_watchdog.sh         # 每 10 分钟 DB 健康看门狗
└── tests/                       # 集成 + 单元测试
```

---

## 文档

| 文档 | 适用场景 |
|------|---------|
| [API 参考](docs/API_REFERENCE.md) | 全部 53 个工具签名 + 示例 |
| [编排指南](docs/advanced-orchestration-guide.md) | Pipeline、并行组、质检门 |
| [进化引擎](docs/evolution-engine-guide.md) | 信任评分、策略审批流程 |
| [Hermes 集成](docs/hermes-integration-guide.md) | Hermes Agent 分步接入 |
| [三层防护](docs/hub-db-split-three-layer-protection.md) | DB 分裂检测、合并、看门狗自愈 |
| [English README](docs/README_EN.md) | 英文版 |

---

## 许可证

MIT — 可自由用于个人和商业项目。

---

<p align="center">
  <em>基于 MCP 协议 + SSE。零外部服务。零厂商锁定。</em>
</p>
