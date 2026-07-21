# Agent Communication Hub — API 参考（v3.0.18）

> 本文档描述 Hub 服务端暴露的 **HTTP / SSE / MCP 端点**与鉴权方式，对应源码 `src/server.ts`、`src/security.ts`、`src/sse.ts`。
>
> - 当前版本：`3.0.18`（由 `src/version.ts` 从 `package.json` 读取，单一真相源）
> - 通过 `/mcp` 暴露 **58 个 MCP 工具**（完整工具权限矩阵见 `src/security.ts` 的 `TOOL_PERMISSIONS`）
> - 存储：SQLite（WAL 模式）

---

## 1. 基础信息

| 项 | 值 |
|----|----|
| 默认监听地址 | `http://localhost:3100` |
| 协议 | HTTP + SSE + MCP（StreamableHTTP） |
| 当前版本 | `3.0.18` |
| MCP 工具数 | 58 |
| 数据库 | SQLite（WAL） |

---

## 2. 认证（Authentication）

所有需要认证的端点通过 **Bearer Token** 鉴权：

```http
Authorization: Bearer <api_token>
```

- Token 在 `register_agent` 时一次性返回；服务端以 SHA-256 哈希存储，明文不落盘。
- 服务端按以下顺序提取 Token（见 `src/security.ts` 的 `extractToken`）：
  1. 请求头 `Authorization: Bearer <token>`
  2. 查询参数 `?token=<token>`（仅 SSE 等少数场景使用，**不建议**用于 REST/MCP）
  3. 请求头 `x-api-key: <token>`
- 缺失或无效 Token → `401`；`/dashboard` 与 `/api/*` 还要求 `role === 'admin'`，否则 `403`。
- 限流：每个 Agent **10 请求/秒**，超出 → `429 { error: "Rate limit exceeded (10 req/s)" }`。

> ⚠️ **安全建议**：Token 不要放在 URL 查询串中（会被访问日志 / 反向代理记录）。REST 与 MCP 一律使用 `Authorization: Bearer`。

### 中间件分级

| 中间件 | 用于端点 | 规则 |
|--------|----------|------|
| `authMiddleware` | `/api/tasks`、`/api/messages`、`/api/consumed`、`/admin/invite/generate` | 必须携带有效 Token（含限流） |
| `internalMonitorAuth` | `/health`、`/health/detailed`、`/metrics` | loopback（127.0.0.1 / ::1）或有效 Token |
| `requireAdminApi` | `/dashboard`、`/api/status`、`/api/agents`、`/api/audit/tail` | 有效 Token **且** `role === 'admin'` |
| `optionalAuthMiddleware` | `/events/:agent_id`、`/mcp` | 有 Token 则校验，无则匿名（auth 置为 undefined） |

---

## 3. 端点速查

### 3.1 健康检查与指标（internalMonitorAuth）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/health` | internalMonitorAuth | 返回 `status` / `version` / `uptime` / 内存占用（rss、heap） |
| GET | `/health/detailed` | internalMonitorAuth | DB 表统计、FTS5 一致性、24h 积压消息数、在线 Agent 列表 |
| GET | `/metrics` | internalMonitorAuth | Prometheus 格式指标（`text/plain; version=0.0.4`） |

> loopback 探针或 Prometheus scraper 同源可直接访问；跨机需带有效 Token。

### 3.2 REST API（authMiddleware，供自动化脚本轮询）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/tasks?agent_id=<id>&status=<s>` | authMiddleware | 列出指定 Agent 的任务；`status` ∈ `pending`/`in_progress`/`completed`/`failed` |
| GET | `/api/messages?agent_id=<id>&status=<s>` | authMiddleware | 列出消息；`status` ∈ `unread`/`delivered`/`read`/`acknowledged` |
| PATCH | `/api/tasks/:id/status` | authMiddleware | body：`status`(`in_progress`/`completed`/`failed`)、`result`、`progress`；成功后 SSE 通知发起方 |
| PATCH | `/api/messages/:id/status` | authMiddleware | body：`status` ∈ `read`/`delivered`/`acknowledged` |
| GET | `/api/consumed?agent_id=<id>&resource=<r>` | authMiddleware | 查询消费水位线（防重复处理）；带 `resource` 查单条，否则列最近 50 条 |
| POST | `/admin/invite/generate` | authMiddleware + admin | 生成邀请码（24h 有效），body：`role`(`admin`/`member`)；返回 `invite_code` |

### 3.3 管理端点（requireAdminApi）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/status` | requireAdminApi | 面板总览：Agent / Pipeline 状态分布、近 5 分钟吞吐、FTS5 状态、限流 Top 10 |
| GET | `/api/agents` | requireAdminApi | 全部 Agent 详情（角色、信任分、最后活跃、在线状态） |
| GET | `/api/audit/tail?n=<50>` | requireAdminApi | 审计日志尾部（最多 500 条） |

### 3.4 MCP 端点（StreamableHTTP，Stateless）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/mcp` | optionalAuthMiddleware | JSON-RPC：`tools/call`、`tools/list`、`initialize` 等 |
| GET | `/mcp` | optionalAuthMiddleware | 建立 MCP 流（SSE 格式响应） |
| DELETE | `/mcp` | optionalAuthMiddleware | 终止 MCP 会话 |

- **无状态（Stateless）模式**：`sessionIdGenerator: undefined`，每次请求独立，不维护服务端 session。**多 Client 必须走 Stateless**。
- 调用时请求头需带 `Accept: application/json, text/event-stream`。
- 权限：`register_agent` 为 `public`（免 Token），其余 57 个工具需先注册并携带 Token（fail-closed：未登记工具一律拒绝）。
- 认证失败（限流/无效 Token）返回 JSON-RPC 错误：`{ jsonrpc:"2.0", error:{ code:-32001, message:"Rate limit exceeded (10 req/s)" }, id:null }`。

### 3.5 SSE 实时推送（optionalAuthMiddleware）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/events/:agent_id` | optionalAuthMiddleware | 长连接，实时推送新消息 / 任务 / 策略 / 交接等事件 |

- 连接示例：
  ```bash
  curl -N \
       -H "Authorization: Bearer <api_token>" \
       -H "Last-Event-ID: <上次事件毫秒时间戳>" \
       http://localhost:3100/events/<agent_id>
  ```
- 每条事件格式（`src/sse.ts` 的 `pushToAgent`）：
  ```
  id: <每连接递增整数>
  event: message
  data: {"event":"new_message","message":{...},"_hub_event_id":<n>,"_hub_dedup_id":<可选>}

  ```
- **断线重连**：客户端在请求头带 `Last-Event-ID`（毫秒时间戳）。服务端解析为整数作为 `since`，调用 `messageRepo.listSince(agent_id, since)` 回放该时间戳之后的消息；回放窗口 `SSE_REPLAY_WINDOW`（默认 3600 秒），超出窗口的部分不补发。
- 首次连接（无 `Last-Event-ID`）：服务端补发离线期间的未读消息与待执行任务。
- 心跳：每 `SSE_HEARTBEAT_INTERVAL`（默认 10000ms）发送 `: ping`。

> ⚠️ **注意区分两种 id**：SSE 事件体的 `id:` 字段是**每连接递增整数**（`_hub_event_id`，用于客户端去重）；而断线重连的 `Last-Event-ID` 请求头被服务端当作**毫秒时间戳**处理（用于 `listSince` 回放）。客户端重连时应记录并回传最近一次事件的**毫秒时间戳**，而非递增 `id`。

### 3.6 Web 管理面板（requireAdminApi）

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/dashboard` | requireAdminApi | 纯静态仪表盘（总览 / Agents / 吞吐 / 健康 / 审计日志） |
| GET | `/` | 重定向 | → `/dashboard` |

---

## 4. 统一错误格式

- 未匹配路由 → `404 { error:true, message:"Not Found", traceId }`
- 未捕获异常 → `500 { error:true, message, traceId }`（非开发环境隐藏原始 message）
- 每个响应均带 `X-Trace-Id` 响应头，便于跨服务追踪。

---

## 5. CORS 与安全响应头

- **CORS**：仅放行 `CORS_ORIGINS`（逗号分隔）中的来源，空 = 拒绝所有跨域；`OPTIONS` 预检返回 `204`。允许的请求头：`Content-Type, Authorization, X-Trace-Id, X-Api-Key`。
- **安全响应头**：`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`X-XSS-Protection: 1; mode=block`、`Strict-Transport-Security: max-age=31536000; includeSubDomains`、`Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`。

---

## 6. 端点汇总

| # | 方法 | 路径 | 鉴权 |
|---|------|------|------|
| 1 | GET | `/health` | internalMonitorAuth |
| 2 | GET | `/health/detailed` | internalMonitorAuth |
| 3 | GET | `/metrics` | internalMonitorAuth |
| 4 | POST | `/admin/invite/generate` | authMiddleware + admin |
| 5 | GET | `/api/tasks` | authMiddleware |
| 6 | GET | `/api/messages` | authMiddleware |
| 7 | PATCH | `/api/tasks/:id/status` | authMiddleware |
| 8 | PATCH | `/api/messages/:id/status` | authMiddleware |
| 9 | GET | `/api/consumed` | authMiddleware |
| 10 | GET | `/api/status` | requireAdminApi |
| 11 | GET | `/api/agents` | requireAdminApi |
| 12 | GET | `/api/audit/tail` | requireAdminApi |
| 13 | GET | `/events/:agent_id`（SSE） | optionalAuthMiddleware |
| 14 | POST | `/mcp` | optionalAuthMiddleware |
| 15 | GET | `/mcp` | optionalAuthMiddleware |
| 16 | DELETE | `/mcp` | optionalAuthMiddleware |
| 17 | GET | `/dashboard` | requireAdminApi |
| 18 | GET | `/` | 重定向 |

> 共 16 个端点路由，其中 `/mcp` 含 POST / GET / DELETE 三方法（共 18 个方法级端点）。58 个 MCP 工具均经 `/mcp` 暴露。
