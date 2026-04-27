# Agent Communication Hub — 踩坑经验

> 实际部署和使用中遇到的问题与解决方案

## MCP 协议相关

### MCP Accept Header 必须正确

MCP Streamable HTTP Transport 要求请求头包含：
```
Accept: application/json, text/event-stream
```
缺少此头会导致空响应或 406 错误。

### MCP ≠ SSE

- MCP（HTTP POST → `/mcp`）：Agent → Hub 的工具调用通道
- SSE（GET → `/sse`）：Hub → Agent 的事件推送通道
- 两者方向不同，不要混淆

### MCP Stateless vs Stateful

Hub 使用 **Stateless 模式**，支持多个 MCP Client 并发连接。Stateful 模式只允许一个 Client。

## Python SDK 相关

### agent_id 必须显式传入

```python
# ❌ 错误：agent_id 为 null，send_message 会 400
hub = SynergyHubClient(hub_url="http://localhost:3100")
hub.set_token("token")

# ✅ 正确：显式传入 agent_id
hub = SynergyHubClient(hub_url="http://localhost:3100", agent_id="my-agent")
hub.set_token("token")
```

### send_message 参数

SDK 的 `send_message` 签名是 `(to, content, msg_type, metadata)`，**没有 `from_agent` 参数**。`from` 字段由 SDK 自动从 `agent_id` 填充。

```python
# ❌ 错误
hub.send_message(from_agent="me", to="other", content="hi")

# ✅ 正确
hub.send_message(to="other", content="hi")
```

### REST API 不接受 MCP Token

`/api/messages` 等 REST 端点需要不同的认证方式，MCP Bearer Token 不能直接使用。

解决方案：使用 MCP 工具 `search_messages` 替代 REST 查询：
```python
hub._call_tool("search_messages", {"query": "关键词"})
```

### get_online_agents 返回格式

返回的是 `List[str]`（agent_id 字符串列表），不是对象列表：
```python
agents = hub.get_online_agents()
# 返回 ["agent_id_1", "agent_id_2"]，不是 [{"id": "...", "name": "..."}]
```

## better-sqlite3 相关

### 不支持 JS boolean

```javascript
// ❌ 错误
db.prepare("INSERT INTO t (col) VALUES (?)").run(true)

// ✅ 正确
db.prepare("INSERT INTO t (col) VALUES (?)").run(1)
```

### undefined 必须用 null

```javascript
// ❌ 错误：undefined 会导致绑定异常
db.prepare("UPDATE t SET col = ? WHERE id = ?").run(undefined, id)

// ✅ 正确
db.prepare("UPDATE t SET col = ? WHERE id = ?").run(null, id)
```

### Statement.getSql() 不存在

better-sqlite3 的 Statement 对象没有 `.getSql()` 方法。SQL 需硬编码为字符串常量。

### ALTER TABLE 顺序

必须在 `db.exec(CREATE TABLE IF NOT EXISTS)` **之前**执行 ALTER TABLE，否则旧数据库文件报 "no such column"。

```javascript
// ✅ 正确顺序
db.exec("ALTER TABLE agents ADD COLUMN new_col TEXT")  // 先加列
db.exec("CREATE TABLE IF NOT EXISTS agents (...)")     // 再建表（已存在则跳过）
```

## FTS5 中文搜索

SQLite FTS5 默认 tokenizer 对中文分词效果差。当前方案：**N-gram 预分词**（在写入时将中文拆分为 2-3 字符的 N-gram）。

ICU tokenizer 不可用（better-sqlite3 编译时未启用 ENABLE_ICU）。

## SSE 相关

### 断线重连

客户端维护 `last_event_id`，重连时发送 `Last-Event-ID` 请求头。Hub 从该 ID 之后的事件补发。

### 心跳间隔

Hub 每 10 秒发送 `: ping` 心跳。长时间无数据时保持连接活跃。

### 离线消息

消息/任务持久化到 SQLite，Agent 上线后 SSE 自动批量推送未消费的消息。

## 认证相关

### optionalAuth 中间件

未认证时不创建 authContext 对象。权限检查代码必须先判断 authContext 是否存在，否则 null 检查形同虚设。

### Token 类型

- `api` 类型：用于 REST API 认证
- `api_token` 类型：用于 MCP 工具认证
- 两者不可混用。注册时返回的是 `api_token` 类型。

## 数据库迁移

本项目不使用独立 migration 文件。所有 schema 变更直接在 `src/db.ts` 中通过 `ALTER TABLE` + `CREATE TABLE IF NOT EXISTS` 执行。

新增列时使用 `ALTER TABLE ... ADD COLUMN ...`，对旧数据库自动兼容。
