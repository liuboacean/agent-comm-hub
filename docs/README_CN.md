# Agent Communication Hub

> 生产级多智能体通信基础设施。实时消息、任务调度、共享记忆、信任进化——基于 MCP + SSE 协议。

---

## 它能解决什么问题？

多个 AI Agent（Claude Code、OpenClaw、WorkBuddy 等）天然是信息孤岛：

- 无法**互相通信**（需要脆弱的 webhook 或共享数据库）
- 无法**跨 Agent 调度任务**
- 无法**共享上下文**（超出单次 prompt）
- 无法**共同进化**（基于团队经验）

**Agent Communication Hub** 为每个 MCP 兼容的 Agent 提供了一个共享神经中枢——消息总线、任务队列、记忆层和进化引擎，让 Agent 协同工作，而非各自为战。

---

## 快速开始

```bash
# 1. 启动 Hub
docker pull ghcr.io/liuboacean/agent-comm-hub:v2.4.5
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.4.5

# 2. 注册 Agent
python3 -c "from hub_client import SynergyHubClient; print(SynergyHubClient('http://localhost:3100').register('YOUR_CODE'))"

# 3. 发消息
python3 -c "from hub_client import SynergyHubClient; c=SynergyHubClient('http://localhost:3100'); c.set_token('YOUR_TOKEN'); c.send_message(to='other-agent', content='Hello!')"
```

---

## 核心特性

| 类别 | 工具数 | 说明 |
|------|:-----:|------|
| 身份认证 | 6 | 注册、心跳、RBAC、信任评分 |
| 消息通信 | 5 | P2P / 广播、全文搜索、去重 |
| 任务调度 | 8 | 7 状态机、Pipeline、并行组、自动重试 |
| 上下文暂存 | 5 | 当前任务范围的临时参考信息 |
| 编排 | 11 | 依赖链、质检门、交接协议 |
| 进化引擎 | 12 | 经验共享、策略审批、信任反馈 |
| 安全 | 6 | Token 认证、4 级 RBAC、审计哈希链 |
| 文件 | 3 | 上传 / 下载 / 列表，Base64 10MB 限制 |

**53 个 MCP 工具** · SQLite WAL（零消息丢失） · SSE 推送延迟 < 50ms

---

## 部署方式

### Docker（推荐）

```bash
docker pull ghcr.io/liuboacean/agent-comm-hub:v2.4.5
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.4.5
```

### 源码

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install && npm run build
npm start
```

### npm 包

```bash
npm install @liuboacean/agent-comm-hub
```

---

## SDK 示例

### Python（零依赖）

```python
from hub_client import SynergyHubClient
hub = SynergyHubClient(hub_url="http://localhost:3100", agent_id="my-agent")
hub.set_token("your-api-token")
hub.send_message(to="workbuddy", content="任务完成，交接。")
```

### TypeScript（零外部依赖）

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";
const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  token: "your-api-token",
  onMessage: async (msg) => { /* 处理 */ },
});
await client.start();
```

---

## 文档

| 文档 | 适用场景 |
|------|---------|
| [API Reference](API_REFERENCE.md) | 全部 53 个工具签名 + 示例 |
| [编排指南](advanced-orchestration-guide.md) | Pipeline、并行组、质检门 |
| [进化引擎](evolution-engine-guide.md) | 信任评分、策略审批流程 |
| [English README](../README.md) | English version |

---

## 交互式 Demo

访问 [在线 Demo](https://liuboacean.github.io/agent-comm-hub/demo/) 体验三步操作流程。

---

## 许可证

MIT — 可自由用于个人和商业项目。
