/**
 * server.ts — 主入口
 * 启动 Express HTTP 服务器 + MCP Server + SSE 推送端点
 *
 * 架构：Stateless 模式
 *   - 每个 MCP 请求创建独立的 transport + server
 *   - 共享 SQLite（模块级单例）和 SSE 管理器
 *   - 支持多个 Agent 客户端同时连接
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { registerClient, removeClient, pushToAgent } from "./sse.js";
import { db, msgStmt, taskStmt, type Task } from "./db.js";

const PORT = Number(process.env.PORT ?? 3100);

const app = express();
app.use(express.json());

// ────────────────────────────────────────────────────────
// SSE 端点：Agent 启动时订阅一次，保持长连接
// GET /events/:agent_id
// ────────────────────────────────────────────────────────
app.get("/events/:agent_id", (req, res) => {
  const { agent_id } = req.params;

  // SSE 必要响应头
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");   // 禁用 Nginx 缓冲
  res.flushHeaders();

  // 注册连接
  registerClient(agent_id, res);

  // ── 补发离线期间积压的未读消息 ──────────────────────
  const pending = msgStmt.pendingFor.all(agent_id) as any[];
  if (pending.length > 0) {
    res.write(`data: ${JSON.stringify({
      event:    "pending_messages",
      messages: pending,
      count:    pending.length,
    })}\n\n`);
    msgStmt.markAllDelivered.run(agent_id);
    console.log(`[SSE] ${agent_id} ← ${pending.length} 条积压消息已补发`);
  }

  // ── 补发积压的未执行任务 ─────────────────────────────
  const pendingTasks = taskStmt.listFor.all(agent_id, "pending") as Task[];
  for (const task of pendingTasks) {
    res.write(`data: ${JSON.stringify({
      event: "task_assigned",
      task: {
        ...task,
        instruction: "你有一项待执行的任务，请立即处理。",
      },
    })}\n\n`);
  }
  if (pendingTasks.length > 0) {
    console.log(`[SSE] ${agent_id} ← ${pendingTasks.length} 个积压任务已推送`);
  }

  // ── 心跳，防止连接超时断线（10 秒间隔）───────────────
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(heartbeat); }
  }, 10_000);

  // ── 断线清理 ──────────────────────────────────────
  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(agent_id);
  });
});

// ────────────────────────────────────────────────────────
// 健康检查端点
// ────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
});

// ────────────────────────────────────────────────────────
// REST API：供自动化脚本通过 curl 轮询任务和消息
// ────────────────────────────────────────────────────────

// GET /api/tasks?agent_id=workbuddy&status=pending
app.get("/api/tasks", (req, res) => {
  const { agent_id, status } = req.query;
  if (!agent_id) {
    res.status(400).json({ error: "agent_id is required" });
    return;
  }
  if (status && !["pending", "in_progress", "completed", "failed"].includes(status as string)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }
  const tasks = status
    ? taskStmt.listFor.all(agent_id, status) as Task[]
    : taskStmt.listFor.all(agent_id, "pending") as Task[];  // 默认查 pending
  res.json({ tasks, count: tasks.length });
});

// GET /api/messages?agent_id=workbuddy&status=unread
app.get("/api/messages", (req, res) => {
  const { agent_id, status } = req.query;
  if (!agent_id) {
    res.status(400).json({ error: "agent_id is required" });
    return;
  }
  if (status && !["unread", "delivered", "read"].includes(status as string)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }
  const messages = status
    ? msgStmt.pendingFor.all(agent_id) as any[]
    : msgStmt.pendingFor.all(agent_id) as any[];  // 默认查 unread
  res.json({ messages, count: messages.length });
});

// PATCH /api/tasks/:id/status — 更新任务状态
app.patch("/api/tasks/:id/status", (req, res) => {
  const { status, result, progress } = req.body;
  if (!["in_progress", "completed", "failed"].includes(status)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }
  const task = taskStmt.getById.get(req.params.id) as Task | undefined;
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  taskStmt.update.run(status, result || null, progress || 0, Date.now(), req.params.id);

  // 通知发起方
  pushToAgent(task.assigned_by, {
    event: "task_updated",
    update: {
      task_id: task.id,
      status,
      result: result || null,
      progress: progress || 0,
      updated_by: "workbuddy-automation",
      timestamp: Date.now(),
    },
  });

  res.json({ success: true, task_id: task.id, status });
});

// PATCH /api/messages/:id/status — 标记消息已读
app.patch("/api/messages/:id/status", (req, res) => {
  const { status } = req.body;
  if (!["read", "delivered"].includes(status)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }
  try {
    const stmt = db.prepare("UPDATE messages SET status=? WHERE id=?");
    stmt.run(status, req.params.id);
    res.json({ success: true, message_id: req.params.id, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────
// MCP 端点：Stateless 模式
//   每个请求创建独立的 server + transport
//   共享 SQLite + SSE（模块级单例）
// ────────────────────────────────────────────────────────

/**
 * 创建一个新的 MCP Server 实例，注册所有工具。
 * tools 内部引用的 db/msgStmt/taskStmt/pushToAgent 都是模块级单例，
 * 所以每个 server 实例共享同一份数据和 SSE 管理器。
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name:    "agent-comm-hub",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // stateless mode
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);

    // 请求结束后清理资源
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("[MCP] handleRequest error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error:   { code: -32603, message: "Internal server error" },
        id:      null,
      });
    }
  }
});

// GET /mcp — SSE streaming（某些 MCP client 会用）
app.get("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, undefined);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("[MCP] GET /mcp error:", error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

// DELETE /mcp — session 关闭
app.delete("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("[MCP] DELETE /mcp error:", error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

// ────────────────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Agent Communication Hub  v1.0.0        ║");
  console.log("║   Stateless Mode — Multi-Client          ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  SSE  订阅: GET  /events/{agent_id}      ║`);
  console.log(`║  MCP  工具: POST /mcp                    ║`);
  console.log(`║  健康检查: GET  /health                  ║`);
  console.log(`║  监听端口: ${PORT}                          ║`);
  console.log("╚══════════════════════════════════════════╝");
});
