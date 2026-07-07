<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24+-green?logo=node.js" alt="Node.js 24+">
  <img src="https://img.shields.io/badge/Python-3.9+-blue?logo=python" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/MCP_Protocol-1.0-orange?logo=robot" alt="MCP Protocol">
  <img src="https://img.shields.io/badge/DB_Split_Protection-v3-green?logo=shield" alt="DB Split Protection">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-SDK-blue?logo=typescript" alt="TypeScript SDK">
  <img src="https://img.shields.io/badge/Python_SDK-Zero_Dependencies-brightgreen?logo=python" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/CI-Passing-3fb950?logo=githubactions" alt="CI">
  <img src="https://img.shields.io/badge/Web_Panel-Online-7c3aed?logo=htmx" alt="Web Panel">
  <a href="https://glama.ai/mcp/servers/liuboacean/agent-comm-hub">
    <img src="https://glama.ai/mcp/servers/liuboacean/agent-comm-hub/badges/score.svg" alt="Glama score">
  </a>
  <a href="demo/index.html">
    <img src="https://img.shields.io/badge/Live_Demo-7f77dd?logo=github" alt="Live Demo">
  </a>
</p>

<h1 align="center">🤖 Agent Communication Hub</h1>
<p align="center">
  <strong>生产级多智能体通信基础设施</strong><br>
  实时消息 · 任务调度 · 共享记忆 · 信任进化 · Web 管理面板<br>
  基于 MCP + SSE 协议，56 个工具，零外部依赖
</p>

<p align="center">
  <a href="#readme">中文</a> · <a href="docs/README_EN.md">English</a>
</p>

> 运行环境：Node.js >= 24（better-sqlite3 原生模块按 Node24 编译，请用 `.nvmrc` 指定版本）

---

## 📖 它能解决什么问题？

多个 AI Agent（Claude Code、OpenClaw、WorkBuddy 等）天然是信息孤岛：

- ❌ 无法**互相通信**（需要脆弱的 webhook 或共享数据库）
- ❌ 无法**跨 Agent 调度任务**
- ❌ 无法**共享上下文**（超出单次 prompt）
- ❌ 无法**共同进化**（基于团队经验）

**Agent Communication Hub** 为每个 MCP 兼容的 Agent 提供共享神经中枢——消息总线、任务队列、记忆层和进化引擎，让 Agent 协同工作，而非各自为战。

---

## 🚀 三步上手

```bash
# 1. 启动 Hub（Docker，推荐）
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.4.7

# 2. 注册 Agent
python3 -c "
from hub_client import SynergyHubClient
hub = SynergyHubClient('http://localhost:3100')
result = hub.register(invite_code='INVITE-001', name='my-agent')
print(f'Token: {result[\"api_token\"]}')
hub.set_token(result['api_token'])
"

# 3. 发消息
python3 -c "
from hub_client import SynergyHubClient
hub = SynergyHubClient('http://localhost:3100')
hub.set_token('your-api-token')
hub.send_message(to='other-agent', content='Hello, Agent!')
"
```

> 零配置文件，零外部服务，本地即用。

---

## ✨ 核心特性

| 类别 | 工具数 | 说明 |
|------|--------|------|
| 🔐 身份认证 | 6 | 注册、心跳、RBAC 角色权限、信任评分 |
| 💬 消息通信 | 5 | P2P / 广播、FTS5 全文搜索、去重 |
| 📋 任务调度 | 8 | 7 状态机、Pipeline、并行组、自动重试 |
| 🧠 共享记忆 | 5 | private / team / collective 三级作用域 |
| 🔀 编排协调 | 11 | 依赖链（DFS 环检测）、质检门、交接协议 |
| 📈 进化引擎 | 12 | 经验共享、4 级策略审批、信任反馈闭环 |
| 🛡️ 安全审计 | 6 | Token 认证、4 级 RBAC、审计哈希链、CORS 白名单 |
| 📎 文件传输 | 3 | 上传 / 下载 / 列表，Base64 10MB 限制 |
| 🔧 高可用防护 | 3 | DB 分裂自动检测 + 合并 + 看门狗自愈 |
| 🖥️ Web 管理面板 | — | 实时仪表盘 / Agent 列表 / 健康检查 / 远程备份状态 |

**56 个 MCP 工具 + Web 管理面板** · SQLite WAL（零消息丢失） · SSE 推送延迟 < 50ms

---

## 🏗️ 架构

```
┌──────────────┐    ┌──────────────────────────┐    ┌──────────────┐
│  Agent A     │SSE │   Agent Communication    │SSE │  Agent B     │
│ (Claude Code)│◄──►│       Hub v2.4           │◄──►│  (WorkBuddy) │
│              │MCP │    localhost:3100        │MCP │              │
└──────────────┘◄───►│                          │◄───►└──────────────┘
                     │  ┌────────────────────┐  │
                     │  │ Identity / RBAC    │  │
                     │  │ Message / Broadcast│  │
                     │  │ Task Scheduler     │  │
                     │  │ Memory (3 scopes)  │  │
                     │  │ Evolution Engine   │  │
                     │  │ Orchestrator       │  │
                     │  └────────┬───────────┘  │
                     └───────────┼──────────────┘
                                 │
                            SQLite (WAL)
```

任何 MCP 兼容的 Agent 都可以连接：Claude Code、OpenClaw、WorkBuddy、自定义 Agent 等。

---

## 🔧 SDK 示例

### Python（零外部依赖）

```python
from hub_client import SynergyHubClient

hub = SynergyHubClient(
    hub_url="http://localhost:3100",
    agent_id="my-agent"
)
hub.set_token("your-api-token")

# 发消息
hub.send_message(to="other-agent", content="任务完成，交接。")

# 存储共享记忆
hub.store_memory(
    content="用户偏好 JSON 响应",
    scope="collective"
)

# 创建任务
task = hub.create_task(
    title="评审 PR #42",
    assignee="claude-code",
    priority=2
)

# 共享经验
hub.share_experience(
    title="DB 锁超时修复方案",
    content="...",
    category="debug"
)

# 实时监听（阻塞式 SSE 长连接）
hub.on_message = lambda msg: print(f"收到: {msg}")
hub.connect_sse()
```

### TypeScript（零外部依赖）

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  token: "your-api-token",
  onMessage: async (msg) => { /* 处理消息 */ },
  onTaskAssigned: async (task) => { /* 处理任务 */ },
});

await client.start();
await client.sendMessage({ to: "other-agent", content: "完成！" });
```

---

## 📦 部署

### Docker（推荐）

```bash
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.4.7
```

### Docker Compose（含 Prometheus + Grafana）

```bash
cd deploy/
docker compose up -d
# Hub:      http://localhost:3100
# Grafana:  http://localhost:3000 (admin/admin)
# Prometheus: http://localhost:9090
```

### 源码安装

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install
npm run build

# 启动（开发模式，含热重载）
npm run dev

# 启动（生产模式）
npm start
```

### 作为 Skill 安装

```bash
# ClawHub
claw install agent-comm-hub

# SkillHub（30+ 平台）
skillhub install agent-comm-hub
```

---

## 🔌 MCP 配置

启动 Hub 后，将其添加到 Agent 的 MCP 配置中：

> ⚠️ 注意：显式设置 `DB_PATH` 环境变量可防止 Node 版本切换导致的多 DB 分裂问题

### 方式一：stdio（推荐）

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "command": "node",
      "args": ["dist/src/stdio.js"],
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

配置完成后，Agent 的 LLM 可以直接通过自然语言调用全部 56 个工具。

---

## 🖥️ Web 管理面板

Hub 自带 Web 管理面板，无需额外安装：

```
http://localhost:3100/dashboard
```

### 功能一览

| 页面 | 内容 |
|------|------|
| **总览仪表盘** | 在线 Agent / Pipeline / 消息吞吐 / FTS5 健康 |
| **Agents** | 完整列表（名称、角色、最后活跃时间、信任分）|
| **Pipelines** | Pipeline 状态分布 |
| **消息吞吐** | 5 分钟消息量 + 限流 Top |
| **健康检查** | 版本、运行时间、DB 状态、备份状态（本地+远程）|
| **审计日志** | 全量操作审计追踪 |

> 面板为纯静态 HTML（内联 CSS+JS），零前端依赖，启动即用。

---

## 🛡️ 安全

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

## 📁 项目结构

```
agent-comm-hub/
├── web/
│   └── dist/
│       └── index.html          # Web 管理面板（静态 HTML）
├── src/                        # Hub 服务端源码（TypeScript）
│   ├── server.ts               # Express + SSE + MCP 入口
│   ├── stdio.ts                # stdio MCP 传输入口
│   ├── db.ts                   # SQLite WAL Schema + 查询
│   ├── backup.ts               # 数据库定时备份模块
│   ├── identity.ts             # 注册、心跳、RBAC
│   ├── memory.ts               # 三级作用域记忆 + FTS5
│   ├── task.ts                 # 7 状态任务调度器
│   ├── orchestrator.ts         # 依赖链、Pipeline
│   ├── evolution.ts            # 策略引擎、信任评分
│   └── security.ts             # 认证、Token、RBAC、审计
├── client-sdk/
│   ├── hub_client.py      # Python SDK（零依赖，68 方法）
│   ├── agent-client.ts    # TypeScript SDK（35 公共方法）
│   └── package.json       # npm 发布配置
├── deploy/
│   ├── docker-compose.yml # Prometheus + Grafana 可观测性
│   └── prometheus.yml     # 指标采集配置
├── docs/
│   ├── API_REFERENCE.md           # 56 工具完整参考
│   ├── advanced-orchestration-guide.md
│   ├── evolution-engine-guide.md
│   ├── hermes-integration-guide.md
│   └── README_EN.md               # 英文版 README
├── scripts/
│   ├── install.sh                 # Hub 服务安装脚本
│   ├── test-e2e.sh                # 端到端测试套件
│   ├── start_hub_server.sh        # 生产启动脚本
│   ├── check_db_consistency.sh    # DB 分裂检测 + 自动合并
│   └── cron_db_watchdog.sh        # 每 10 分钟 DB 健康看门狗
├── tests/                  # 集成 + 单元测试
├── demo/                   # 交互式在线演示
└── .github/workflows/
    ├── ci.yml              # CI (typecheck + test + coverage)
    └── docker.yml          # Docker 构建发布
```

---

## 📚 文档

| 文档 | 适用场景 |
|------|----------|
| [API 参考](docs/API_REFERENCE.md) | 全部 56 个工具签名 + 示例 |
| [编排指南](docs/advanced-orchestration-guide.md) | Pipeline、并行组、质检门 |
| [进化引擎](docs/evolution-engine-guide.md) | 信任评分、策略审批流程 |
| [Hermes 集成](docs/hermes-integration-guide.md) | Hermes Agent 分步接入 |
| [三层防护](docs/hub-db-split-three-layer-protection.md) | DB 分裂检测、合并、看门狗自愈 |
| [English README](docs/README_EN.md) | 英文版 |

---

## 🆕 最近更新

### v2.5.0 (2026-07-07)
- 🖥️ **Web 管理面板** — 纯静态 HTML 仪表盘（零前端依赖），登录后即可查看：
  - 总览仪表盘（Agent/Pipeline/消息吞吐/FTS5 健康）
  - Agent 列表（名称/角色/最后活跃时间/信任分）
  - Pipeline / 消息吞吐 / 健康检查页面
  - 审计日志实时追踪（每 15 秒自动刷新）
- 🔄 **在线状态改进** — 二元「在线/离线」标签改为「最后活跃时间」，心跳超时不再跳变
- 📦 **备份模块** — `src/backup.ts` 定时备份 DB，健康检查页展示本地+远程备份状态
- ⏱️ **持久化运行时间** — `server_config` 表存储首次启动时间戳，重启不归零
- 📊 **新增 API** — `GET /api/agents` 返回 Agent 列表详情
- 🔧 **`.gitignore` 清理** — 移除已跟踪的 `dist/` 和 `src/*.js` 编译产物

### v2.4.7 (2026-06-09)
- 🔍 **FTS5 标签分词修复** — 空格拼接替代 JSON，版本号/hash 可正确搜索
- 📊 **静默吞异常修复** — 12 处全链路 logError，信任分/DB 统计/SSE 可观测
- 🔐 **统一认证中间件** — `authed()` 重构，零 `requireAuth` 残留

### v2.4.6 (2026-06-09)
- 🔒 **FTS5 索引守护** — 每次存储记忆后自动校验索引完整性
- 🛣️ **数据库路径外部化** — 支持 `HUB_ROOT` 环境变量
- 📨 **新增 MCP 工具** — `generate_invite` 安全生成注册邀请码
- 🧪 **测试覆盖** — 新增 19 个 identity + evolution 测试用例

---

## 🤝 贡献

欢迎贡献！详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 🐛 报告 bug — 提交 Issue
- ✨ 功能请求 — 提交 Feature Request
- 📖 改进文档 — 提交 PR
- 🔧 代码贡献 — Fork 后提交 PR

---

## 📄 许可证

MIT — 可自由用于个人和商业项目。

---

<p align="center">
  <em>基于 MCP 协议 + SSE。零外部服务。零厂商锁定。</em>
</p>
