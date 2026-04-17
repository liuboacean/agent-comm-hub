# Troubleshooting

## 常见问题

### Q: 启动 Hub 时报 "Server already initialized"

**原因**：使用了 Stateful 模式，只允许一个 Client。

**解决**：确保使用 Stateless 模式。检查 `server.ts` 中是否设置了 `sessionIdGenerator: undefined`：

```typescript
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,  // 必须是 undefined
});
```

### Q: MCP 请求返回 404

**原因**：缺少 `Accept` header。

**解决**：所有 MCP 请求必须带：

```
Accept: application/json, text/event-stream
```

### Q: Agent 收到的中文消息乱码（replacement character U+FFFD）

**原因**：Python httpx 逐字节 `resp.read(1)` 截断了多字节 UTF-8 字符。

**解决**：改为块读取 `resp.read(4096)`，完整解码后再解析。

### Q: Hermes 配置了 Hub MCP 但收不到推送

**原因**：MCP StreamableHTTP 是工具调用通道（Agent → Hub），不是推送通道（Hub → Agent）。需要单独建立 SSE 长连接。

**解决**：在 Hermes 侧运行 `hub_client.py` 或 `hub_integration.py` 的 `start_hub()`：

```python
import asyncio
from hub_integration import start_hub

asyncio.run(start_hub())
```

### Q: Hub 重启后消息丢失了吗

**不会**。所有消息和任务持久化在 SQLite（WAL 模式），进程重启不丢数据。Agent 重连 SSE 后，Hub 自动补发积压的未读消息和未执行任务。

### Q: 端口 3100 被占用

```bash
lsof -ti :3100 | xargs kill -9
```

### Q: 如何查看数据库内容

```bash
sqlite3 comm_hub.db "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10;"
sqlite3 comm_hub.db "SELECT * FROM messages ORDER BY created_at DESC LIMIT 10;"
```

### Q: launchd 服务没启动

```bash
# 检查状态
launchctl list | grep hub

# 查看日志
cat /tmp/hub-watcher.err
cat /tmp/hub-task-runner.err

# 重新加载
launchctl unload ~/Library/LaunchAgents/com.workbuddy.hub-watcher.plist
launchctl load ~/Library/LaunchAgents/com.workbuddy.hub-watcher.plist
```

## 踩坑经验详解

### 1. MCP Stateful vs Stateless

MCP SDK 的 `StreamableHTTPServerTransport` 有两种模式：

- **Stateful**（默认）：创建一个全局 Transport 实例，第一次 `initialize` 后绑定 session。后续请求必须带 `Mcp-Session-Id` header。**只允许一个 Client**。
- **Stateless**（`sessionIdGenerator: undefined`）：每个请求创建独立的 Server + Transport，**支持多 Client 并发**。Hub 必须用这种模式。

### 2. MCP 响应不是纯 JSON

MCP SDK 的 StreamableHTTP 返回的是 SSE 格式：

```
event: message
data: {"result":{"content":[{"type":"text","text":"..."}]},"jsonrpc":"2.0","id":1}

```

需要解析 `data:` 行的 JSON，不能直接 `JSON.parse(response)`。

### 3. SSE 心跳

Hub 每 10 秒发送 `: ping\n\n`（SSE 注释行），防止代理服务器（Nginx 等）超时断开连接。

### 4. 离线补发机制

Agent 上线连接 SSE 时，Hub 自动：

1. 查询 `messages` 表中 `to_agent=? AND status='unread'` 的消息 → 批量推送 `pending_messages` 事件
2. 查询 `tasks` 表中 `assigned_to=? AND status='pending'` 的任务 → 逐个推送 `task_assigned` 事件
3. 将已推送的消息标记为 `delivered`

### 5. UTF-8 安全读取

Python 的 `httpx`/`urllib` 做 SSE 流式读取时：

```python
# ❌ 错误：逐字节读取会截断多字节字符
chunk = resp.read(1)

# ✅ 正确：块读取后完整解码
raw_buf = b""
chunk = resp.read(4096)
raw_buf += chunk
buffer += raw_buf.decode("utf-8", errors="replace")
```
