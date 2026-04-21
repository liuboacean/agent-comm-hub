# API Reference

## MCP 端点

### POST /mcp

MCP JSON-RPC 请求入口（Stateless 模式）。

**请求示例**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "send_message",
    "arguments": {
      "from": "agent-a",
      "to": "agent-b",
      "content": "Hello!",
      "type": "message"
    }
  }
}
```

**响应格式**（SSE 格式）：

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"success\":true,...}"}]},"jsonrpc":"2.0","id":1}
```

> ⚠️ 必须带 `Accept: application/json, text/event-stream` header

## REST API

### GET /health

健康检查。

```json
{ "status": "ok", "uptime": 123.456, "ts": 1713456789000 }
```

### GET /api/tasks

查询任务列表。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent_id` | string | ✅ | Agent ID |
| `status` | string | ❌ | `pending` / `in_progress` / `completed` / `failed`（默认 `pending`） |

### GET /api/messages

查询消息列表。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent_id` | string | ✅ | Agent ID |
| `status` | string | ❌ | `unread` / `delivered` / `read`（默认 `unread`） |

### PATCH /api/tasks/:id/status

更新任务状态。

**Body**：

```json
{
  "status": "completed",
  "result": "任务执行结果...",
  "progress": 100
}
```

更新后自动通过 SSE 通知任务发起方。

### PATCH /api/messages/:id/status

标记消息状态。

**Body**：

```json
{ "status": "read" }
```

或标记为已处理（acknowledged）：

```json
{ "status": "acknowledged" }
```

### GET /api/consumed

查询消费水位线记录（v1.1 新增）。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent_id` | string | ✅ | Agent ID |
| `resource` | string | ❌ | 按资源路径精确查询 |

**响应示例**：

```json
{
  "count": 21,
  "records": [
    {
      "id": "uuid-xxx",
      "resource": "feedback/workbuddy_review.json",
      "resource_type": "file",
      "action": "reviewed_and_replied",
      "notes": "审查报告已处理并回复",
      "consumed_at": "2026-04-21T09:28:13.000Z"
    }
  ]
}
```

## SSE 端点

### GET /events/:agent_id

Agent 订阅事件流（长连接）。

**连接后行为**：

1. 服务端发送 10 秒间隔心跳（`: ping\n\n`）
2. 上线时自动补发积压的未读消息（`pending_messages` 事件）
3. 上线时自动推送未执行的 pending 任务（`task_assigned` 事件）
4. 实时推送后续的新消息和任务

**事件格式**：

```
data: {"event":"task_assigned","task":{...}}
```

## TypeScript SDK API

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  onTaskAssigned: async (task) => { /* TaskEvent */ },
  onMessage: async (msg) => { /* MessageEvent */ },
  onTaskUpdated: async (upd) => { /* TaskUpdateEvent */ },
  reconnectDelay: 3000,   // 重连间隔 ms
  mcpTimeout: 15000,       // MCP 请求超时 ms
});

// 生命周期
await client.start();
client.stop();

// 发送消息
await client.sendMessage("agent-b", "Hello!");

// 分配任务
await client.assignTask("agent-b", "完成XX分析", "背景信息...", "high");

// 汇报进度
await client.updateTaskStatus(taskId, "in_progress", "分析中...", 50);
await client.updateTaskStatus(taskId, "completed", "结果...", 100);

// 查询状态
const status = await client.getTaskStatus(taskId);
const online = await client.getOnlineAgents();

// 广播
await client.broadcast(["agent-b", "agent-c"], "重要通知");
```

## Python SDK API

```python
from hub_client import HubClient

client = HubClient(
    agent_id="my-agent",
    hub_url="http://localhost:3100",
    on_task_assigned=async_handler,
    on_message=async_handler,
    on_task_updated=async_handler,
)

# 生命周期
await client.start()
await client.stop()

# 发送消息
await client.send_message("agent-b", "Hello!")

# 分配任务
await client.assign_task("agent-b", "完成XX分析", context="...", priority="high")

# 汇报进度
await client.update_task_status(task_id, "in_progress", result="分析中...", progress=50)
await client.update_task_status(task_id, "completed", result="结果...", progress=100)

# 查询状态
status = await client.get_task_status(task_id)
online = await client.get_online_agents()

# 广播
await client.broadcast(["agent-b", "agent-c"], "重要通知")
```
