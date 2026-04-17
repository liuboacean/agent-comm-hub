# Setup Guide

## 完整配置指南

本文档详细说明如何在不同场景下配置和使用 Agent Communication Hub。

---

## 场景 1：WorkBuddy + Hermes（最常用）

### 步骤 1：启动 Hub 服务器

在 WorkBuddy 所在机器上：

```bash
cd agent-comm-hub/hub-server
npm install
npm run dev   # 或 nohup npm start &
```

### 步骤 2：配置 WorkBuddy MCP

在 WorkBuddy 的 `.mcp.json` 或 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### 步骤 3：配置 Hermes MCP

在 Hermes 的 `.mcp.json` 或 `config.yaml` 中添加：

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### 步骤 4：启动 WorkBuddy SSE 守护（秒级响应）

```bash
SKILL_DIR="path/to/agent-comm-hub"

# 修改 plist 中的路径
sed -i '' "s|WORKBUDDY_SKILL_DIR|$SKILL_DIR|g" \
  $SKILL_DIR/workbuddy-side/launchd/*.plist

# 安装 launchd 服务
cp $SKILL_DIR/workbuddy-side/launchd/*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-watcher.plist
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-task-runner.plist

# 验证
launchctl list | grep hub
```

### 步骤 5：启动 Hermes SSE 客户端

```bash
cd $SKILL_DIR/hermes-side/scripts
pip install httpx  # 如果未安装
python3 hub_integration.py  # 前台运行测试
```

或后台运行：

```bash
nohup python3 $SKILL_DIR/hermes-side/scripts/hub_integration.py > /tmp/hermes-hub.log 2>&1 &
```

### 步骤 6：验证

```bash
# 健康检查
curl http://localhost:3100/health

# 查看在线 Agent
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_agents","arguments":{}}}'
```

预期：两个 Agent 都在线。

---

## 场景 2：通用 Agent 接入

任何支持 MCP 协议的 Agent 都可以接入 Hub：

### TypeScript/Node.js Agent

```typescript
import { AgentClient } from "agent-comm-hub/client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-custom-agent",
  hubUrl: "http://your-hub-server:3100",
  onTaskAssigned: async (task) => {
    // 处理任务...
    await client.updateTaskStatus(task.id, "completed", "done", 100);
  },
});
await client.start();
```

### Python Agent

```python
from hub_client import HubClient

client = HubClient(
    agent_id="my-custom-agent",
    hub_url="http://your-hub-server:3100",
    on_task_assigned=on_task_handler,
)
await client.start()
```

### 纯 MCP 配置（无需代码）

在 Agent 的 MCP 配置中添加 Hub URL 即可，LLM 可以直接调用 Hub 的 6 个工具。

---

## 场景 3：远程部署

Hub 和 Agent 可以在不同机器上运行，只需确保网络互通。

### Hub 服务器

```bash
# 设置监听地址（默认 0.0.0.0，所有网卡）
PORT=3100 npm start
```

### Agent 客户端

```bash
# 设置 Hub URL 为远程地址
export HUB_URL=http://192.168.1.100:3100
```

### 防火墙

确保 Hub 服务器的 3100 端口对 Agent 开放。

---

## 环境变量完整列表

### Hub 服务器

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | 监听端口 |

### WorkBuddy 守护

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_URL` | http://localhost:3100 | Hub 地址 |
| `HUB_AGENT_ID` | workbuddy | Agent ID |
| `HUB_WATCHER_LOG` | INFO | 日志级别 |
| `WB_TRIGGER_DIR` | ~/.workbuddy/hub-tasks | 触发文件目录 |
| `SIGNAL_DIR` | ~/.hermes/shared/signals | 信号文件目录 |

### Hermes 客户端

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_URL` | http://localhost:3100 | Hub 地址 |
| `HERMES_ID` | hermes | Agent ID |

---

## 日志位置

| 组件 | 日志 |
|------|------|
| Hub 服务器 | 控制台输出（npm run dev） |
| hub_watcher | /tmp/hub-watcher.log + /tmp/hub-watcher.err |
| hub_task_runner | /tmp/hub-task-runner.log + /tmp/hub-task-runner.err |
| Hermes hub_client | 控制台输出 / logging 配置 |

---

## 数据库维护

```bash
# 查看数据库大小
ls -lh hub-server/comm_hub.db

# 查看任务统计
sqlite3 hub-server/comm_hub.db "
SELECT status, COUNT(*) as count FROM tasks GROUP BY status;
"

# 查看消息统计
sqlite3 hub-server/comm_hub.db "
SELECT status, COUNT(*) as count FROM messages GROUP BY status;
"

# 清理已完成任务（30天前）
sqlite3 hub-server/comm_hub.db "
DELETE FROM tasks WHERE status IN ('completed','failed') AND updated_at < (strftime('%s','now') - 30*86400) * 1000;
"

# WAL 检查点（减小数据库文件大小）
sqlite3 hub-server/comm_hub.db "PRAGMA wal_checkpoint(TRUNCATE);"
```
