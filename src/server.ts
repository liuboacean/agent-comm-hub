/**
 * server.ts — 主入口
 * Express HTTP 服务器 + MCP Server + SSE 推送 + Security 中间件
 *
 * Phase 5b 变更：
 *   - 结构化 JSON 日志（logger.ts）
 *   - 全局错误处理中间件
 *   - 增强健康检查（/health）
 *   - 优雅关闭（SIGTERM/SIGINT）
 *   - Prometheus metrics 端点（/metrics）
 *   - CORS + 安全头中间件
 *   - 请求追踪（traceId）
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { registerClient, removeClient, pushToAgent, onlineAgents, drainAllClients, startZombieCleanup, stopZombieCleanup, broadcastToAll, writeStoredEvent } from "./sse.js";
import { eventLogRepo } from "./repo/event-log.js";
import { getDbStats, db, scheduleCleanup, stopCleanup } from "./db.js";
import { messageRepo, taskRepo, consumedRepo } from "./repo/sqlite-impl.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
  internalMonitorAuth,
  requireAdminApi,
  checkPermission,
  getRequiredPermission,
  createInviteCode,
  auditLog,
  rateLimiter,
  type AuthContext,
} from "./security.js";
import { startHeartbeatMonitor, clearOfflineNotification, stopHeartbeatMonitor } from "./identity.js";
import { startDedupCleanup, stopDedupCleanup } from "./dedup.js";
import { getErrorMessage } from "./types.js";
import { rebuildFtsIndex } from "./memory.js";
import { logger, logError } from "./logger.js";
import { join } from "path";
import {
  getMetricsOutput,
  trackHttpRequest,
  setGauge,
  incrementGauge,
  decrementGauge,
  collectHubMetrics,
  getTopLimited,
} from "./metrics.js";
import { ActivationOrchestrator } from "./orchestrator.js";
import { RateLimiter } from "./ratelimit.js";
import { setMessageRateLimiter } from "./tools/message.js";
import { createDashboardRouter } from "./web/server.js";
import { startBackupScheduler, stopBackupScheduler } from "./backup.js";
import { HUB_VERSION } from "./version.js";

// ═══════════════════════════════════════════════════════════════
// Phase 6: 配置外部化（零依赖，所有配置有默认值）
// ═══════════════════════════════════════════════════════════════
const config = {
  port:                      parseInt(process.env.PORT ?? "3100", 10),
  logLevel:                  process.env.LOG_LEVEL || "info",
  corsOrigins:               (process.env.CORS_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  dbPath:                    process.env.DB_PATH || "./comm_hub.db",
  sseHeartbeatInterval:      parseInt(process.env.SSE_HEARTBEAT_INTERVAL ?? "10000", 10),
  sseReplayWindow:           parseInt(process.env.SSE_REPLAY_WINDOW ?? "3600", 10) * 1000,
  rateLimitWindow:           parseInt(process.env.RATE_LIMIT_WINDOW ?? "1000", 10),
  rateLimitMax:              parseInt(process.env.RATE_LIMIT_MAX ?? "10", 10),
  heartbeatOnlineThreshold:  parseInt(process.env.HEARTBEAT_ONLINE_THRESHOLD ?? "90000", 10),
  heartbeatNotifyThreshold:  parseInt(process.env.HEARTBEAT_NOTIFY_THRESHOLD ?? "300000", 10),
  heartbeatCheckInterval:    parseInt(process.env.HEARTBEAT_CHECK_INTERVAL ?? "30000", 10),
  dedupTTL:                  parseInt(process.env.DEDUP_TTL ?? "900", 10) * 1000,
  dedupCleanupInterval:      parseInt(process.env.DEDUP_CLEANUP_INTERVAL ?? "60000", 10),
  tokenExpireDays:           parseInt(process.env.TOKEN_EXPIRE_DAYS ?? "90", 10),
  uploadDir:                 process.env.UPLOAD_DIR || join(process.cwd(), "uploads"),
  maxFileSize:               parseInt(process.env.MAX_FILE_SIZE ?? "10485760", 10),  // 10MB
};

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// Phase 5b: CORS 中间件（零依赖）
// ═══════════════════════════════════════════════════════════════
const CORS_ORIGINS = config.corsOrigins;

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Trace-Id, X-Api-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 安全头中间件（零依赖 Helmet 替代）
// ═══════════════════════════════════════════════════════════════
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
  next();
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 请求追踪（traceId）
// ═══════════════════════════════════════════════════════════════
app.use((req: Request, res: Response, next: NextFunction) => {
  const traceId = (req.headers["x-trace-id"] as string) || crypto.randomUUID().slice(0, 8);
  (req as any).traceId = traceId;
  res.setHeader("X-Trace-Id", traceId);
  next();
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: HTTP 请求日志 + metrics 中间件
// ═══════════════════════════════════════════════════════════════
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const traceId = (req as any).traceId;
    logger.info("http_request", {
      traceId,
      module: "server",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
    });
    trackHttpRequest(req.method, req.path, res.statusCode, duration);
  });
  next();
});

// ═══════════════════════════════════════════════════════════════
// SSE 端点：Agent 启动时订阅一次，保持长连接
// GET /events/:agent_id  （认证见 D7：仅 Authorization: Bearer）
// ═══════════════════════════════════════════════════════════════

app.get("/events/:agent_id", optionalAuthMiddleware, (req: Request, res: Response) => {
  const { agent_id } = req.params;
  const authContext: AuthContext | undefined = req.auth?.agent;

  // SSE 必要响应头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // 注册连接
  registerClient(agent_id, res);
  incrementGauge("active_sse_connections");

  // 检查 Last-Event-ID（断线重连场景）
  // D1 修复：Last-Event-ID 即持久化事件日志的全局单调 seq；
  // 重连时只精确补发 id > seq 的事件（不重放整窗），且覆盖所有事件类型。
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  const parsedLast = lastEventId ? parseInt(lastEventId, 10) : NaN;

  if (!isNaN(parsedLast)) {
    // 重连：精确补发 seq 之后的全部事件（new_message / task_assigned / activation 等）
    const missed = eventLogRepo.getEventsAfter(parsedLast, agent_id);
    if (missed.length > 0) {
      for (const ev of missed) {
        if (writeStoredEvent(agent_id, ev)) {
          eventLogRepo.markDelivered(ev.id);
        }
      }
      logger.info("SSE replay", { module: "sse", agent_id, replay_count: missed.length, since_seq: parsedLast });
    }
  } else {
    // 首次连接：补发未投递（delivered=0）的持久化事件，覆盖所有事件类型
    const undelivered = eventLogRepo.getUndelivered(agent_id);
    for (const ev of undelivered) {
      if (writeStoredEvent(agent_id, ev)) {
        eventLogRepo.markDelivered(ev.id);
      }
    }

    // 兼容历史数据：补发离线期间积压的未读消息。
    // D1 修复：仅当推送成功才标记 delivered，推送失败不标记（避免消息永久丢失）。
    const pending = messageRepo.pendingFor(agent_id);
    if (pending.length > 0) {
      let delivered = 0;
      for (const msg of pending) {
        const ok = pushToAgent(agent_id, { event: "new_message", message: msg });
        if (ok) {
          messageRepo.markDelivered(msg.id);
          delivered++;
        }
      }
      logger.info("SSE backfill", { module: "sse", agent_id, pending_count: pending.length, delivered });
    }
  }

  // 补发积压的未执行任务（保留原行为；重连场景下由 event_log 回放覆盖，此处幂等重发）
  const pendingTasks = taskRepo.listFor(agent_id, "pending");
  for (const task of pendingTasks) {
    pushToAgent(agent_id, {
      event: "task_assigned",
      task: {
        ...task,
        instruction: "你有一项待执行的任务，请立即处理。",
      },
    });
  }
  if (pendingTasks.length > 0) {
    logger.info("SSE tasks push", { module: "sse", agent_id, pending_tasks: pendingTasks.length });
  }

  // 心跳（10 秒间隔）
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(heartbeat); }
  }, config.sseHeartbeatInterval);

  // 断线清理
  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(agent_id);
    decrementGauge("active_sse_connections");
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 增强健康检查端点（免认证）
// ═══════════════════════════════════════════════════════════════
app.get("/health", internalMonitorAuth, (_req: Request, res: Response) => {
  const mem = process.memoryUsage();

  res.json({
    status: "ok",
    version: HUB_VERSION,
    uptime: getPersistentUptime(),
    first_start_ms: serverStartTime,
    timestamp: Date.now(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heap_used: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// P2-5: 详细健康检查端点（免认证）
// ═══════════════════════════════════════════════════════════════
app.get("/health/detailed", internalMonitorAuth, (_req: Request, res: Response) => {
  const stats = getDbStats();
  const mem = process.memoryUsage();
  const agents = onlineAgents();

  // FTS5 索引状态
  let fts5Status = "unknown";
  try {
    const memMain = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any;
    const memFts = db.prepare("SELECT COUNT(*) as cnt FROM memories_fts").get() as any;
    const stratFts = db.prepare("SELECT COUNT(*) as cnt FROM strategies_fts").get() as any;
    fts5Status = memMain.cnt === memFts.cnt ? "consistent" : "drifted";
  } catch (err) { logError("health_detailed_fts5_failed", err, { module: "server" }); }

  // 消息队列深度（24h 内未确认消息数）
  let pendingMessages = 0;
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE status IN ('unread','delivered') AND created_at > ?"
    ).get(Date.now() - 86400_000) as any;
    pendingMessages = row?.cnt ?? 0;
  } catch (err) { logError("health_detailed_msg_pending_failed", err, { module: "server" }); }

  res.json({
    status: "ok",
    version: HUB_VERSION,
    uptime: getPersistentUptime(),
    first_start_ms: serverStartTime,
    timestamp: Date.now(),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    agents: {
      online: agents.length,
      online_ids: agents,
    },
    fts5: {
      status: fts5Status,
    },
    messages: {
      pending_24h: pendingMessages,
    },
    db: {
      tables: stats,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: Prometheus Metrics 端点（免认证）
// ═══════════════════════════════════════════════════════════════
app.get("/metrics", internalMonitorAuth, (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  // Phase 3.1: 拼接 Hub 数据库指标（agents / messages / trust_scores）
  const hubMetrics = collectHubMetrics(db);
  const output = getMetricsOutput() + hubMetrics;
  res.send(output);
});

// ═══════════════════════════════════════════════════════════════
// 管理端点：/admin/invite/generate — 生成邀请码
// ═══════════════════════════════════════════════════════════════
app.post("/admin/invite/generate", authMiddleware, (req: Request, res: Response) => {
  const role = req.auth?.agent?.role;
  if (role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const targetRole = req.body.role === "admin" ? "admin" as const : "member" as const;
  const code = createInviteCode(targetRole);

  auditLog("invite_generated", req.auth?.agent?.agentId ?? null, undefined, `role=${targetRole}`);

  res.json({
    success: true,
    invite_code: code,
    role: targetRole,
    expires_in: "24h",
  });
});

// ═══════════════════════════════════════════════════════════════
// REST API：供自动化脚本通过 curl 轮询任务和消息（需认证）
// ═══════════════════════════════════════════════════════════════

// GET /api/tasks?agent_id=workbuddy&status=pending
app.get("/api/tasks", authMiddleware, (req: Request, res: Response) => {
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
    ? taskRepo.listFor(agent_id as string, status as string)
    : taskRepo.listFor(agent_id as string, "pending");
  res.json({ tasks, count: tasks.length });
});

// GET /api/messages?agent_id=workbuddy&status=unread
app.get("/api/messages", authMiddleware, (req: Request, res: Response) => {
  const { agent_id, status } = req.query;
  if (!agent_id) {
    res.status(400).json({ error: "agent_id is required" });
    return;
  }
  const validStatuses = ["unread", "delivered", "read", "acknowledged"];
  if (status && !validStatuses.includes(status as string)) {
    res.status(400).json({ error: `Invalid status: ${status}. Valid: ${validStatuses.join(", ")}` });
    return;
  }
  const queryStatus = (status as string) || "unread";
  const messages = messageRepo.listByStatus(agent_id as string, queryStatus);
  res.json({ messages, count: messages.length });
});

// PATCH /api/tasks/:id/status
app.patch("/api/tasks/:id/status", authMiddleware, (req: Request, res: Response) => {
  const { status, result, progress } = req.body;
  if (!["in_progress", "completed", "failed"].includes(status)) {
    res.status(400).json({ error: `Invalid status: ${status}` });
    return;
  }
  const task = taskRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  taskRepo.update(req.params.id, status, result || null, progress || 0);

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

// PATCH /api/messages/:id/status
app.patch("/api/messages/:id/status", authMiddleware, (req: Request, res: Response) => {
  const { status } = req.body;
  const validStatuses = ["read", "delivered", "acknowledged"];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status: ${status}. Valid: ${validStatuses.join(", ")}` });
    return;
  }
  try {
    messageRepo.updateStatus(req.params.id, status);
    res.json({ success: true, message_id: req.params.id, status });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/consumed?agent_id=hermes&resource=feedback/xxx.json
app.get("/api/consumed", authMiddleware, (req: Request, res: Response) => {
  const { agent_id, resource } = req.query;
  if (!agent_id) {
    res.status(400).json({ error: "agent_id is required" });
    return;
  }
  if (resource) {
    const record = consumedRepo.check(agent_id as string, resource as string);
    res.json({
      consumed: !!record,
      resource,
      record: record || null,
    });
  } else {
    const records = consumedRepo.listByAgent(agent_id as string, 50);
    res.json({ records, count: records.length });
  }
});

// ═══════════════════════════════════════════════════════════════
// P1-4: 激活编排层 + P2-8: 限流 — 初始化
// ═══════════════════════════════════════════════════════════════

const activationOrch = new ActivationOrchestrator();
activationOrch.replayFromAudit(); // 从 audit_log 恢复状态
activationOrch.seedFromDb();      // D2：从 agents 表 seed 激活态（DB 为权威，覆盖 audit 回放）
import { setActivationOrchestrator } from "./tools/orchestrator.js";
setActivationOrchestrator(activationOrch);

const msgRateLimiter = new RateLimiter();
setMessageRateLimiter(msgRateLimiter);

// ═══════════════════════════════════════════════════════════════
// P2-7: Web 管理面板端点
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/status — 面板总览指标（免认证，仅读数据）
 */
app.get("/api/status", requireAdminApi, (_req: Request, res: Response) => {
  const agents = activationOrch.getAllAgentStates();
  const agentStateCount: Record<string, number> = {};
  for (const a of agents) {
    agentStateCount[a.state] = (agentStateCount[a.state] ?? 0) + 1;
  }

  const pipelines = activationOrch.getAllPipelineStates();
  const pipelineStateCount: Record<string, number> = {};
  for (const p of pipelines) {
    pipelineStateCount[p.state] = (pipelineStateCount[p.state] ?? 0) + 1;
  }

  // 数据库回退：orchestrator 内存状态可能为空（重启后），从 DB 取总量
  let dbAgentTotal = 0;
  let dbAgentOnline = 0;
  let dbPipelineTotal = 0;
  try {
    const aRow = db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as any;
    dbAgentTotal = aRow?.cnt ?? 0;
    const aOnline = db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE last_heartbeat > ?").get(Date.now() - 300_000) as any;
    dbAgentOnline = aOnline?.cnt ?? 0;
    const pRow = db.prepare("SELECT COUNT(*) as cnt FROM pipelines").get() as any;
    dbPipelineTotal = pRow?.cnt ?? 0;
  } catch { /* tables may not exist yet */ }

  // 近 5 分钟消息量
  const fiveMinAgo = Date.now() - 300_000;
  let last5min = 0;
  try {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE created_at > ?"
    ).get(fiveMinAgo) as any;
    last5min = row?.cnt ?? 0;
  } catch { /* table may not exist yet */ }

  // FTS5 健康
  let fts5Status = "unknown";
  try {
    const memMain = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any;
    const memFts = db.prepare("SELECT COUNT(*) as cnt FROM memories_fts").get() as any;
    fts5Status = memMain.cnt === memFts.cnt ? "consistent" : "drifted";
  } catch { /* FTS5 may not exist */ }

  // 限流 Top
  const topLimited = getTopLimited(10);

  res.json({
    agents: {
      total: agents.length || dbAgentTotal,
      online: agents.filter(a => a.state === "active").length || dbAgentOnline,
      by_state: agentStateCount,
    },
    pipelines: {
      total: pipelines.length || dbPipelineTotal,
      by_state: pipelineStateCount,
    },
    throughput: {
      last_5min: last5min,
    },
    health: {
      fts5: fts5Status,
      active_sse: onlineAgents().length,
    },
    top_limited: topLimited,
    timestamp: Date.now(),
  });
});

/**
 * GET /api/agents — 所有 Agent 列表（含详情）
 */
app.get("/api/agents", requireAdminApi, (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(
      "SELECT agent_id, name, role, status, trust_score, last_heartbeat, created_at FROM agents ORDER BY last_heartbeat DESC"
    ).all() as any[];
    const now = Date.now();
    const agents = rows.map(r => {
      let last_seen: string;
      const diff = r.last_heartbeat != null ? now - r.last_heartbeat : Infinity;
      if (r.last_heartbeat == null) {
        last_seen = "从未活跃";
      } else if (diff < 60_000) last_seen = "刚刚活跃";
      else if (diff < 3600_000) last_seen = `${Math.floor(diff / 60_000)} 分钟前`;
      else if (diff < 86_400_000) last_seen = `${Math.floor(diff / 3600_000)} 小时前`;
      else last_seen = `${Math.floor(diff / 86_400_000)} 天前`;
      return {
        agent_id: r.agent_id,
        name: r.name,
        role: r.role,
        trust_score: r.trust_score,
        last_heartbeat: r.last_heartbeat,
        created_at: r.created_at,
        last_seen,
        online: r.last_heartbeat != null && diff < 300_000,
      };
    });
    res.json({ agents });
  } catch {
    res.json({ agents: [] });
  }
});

/**
 * GET /api/audit/tail — 审计日志尾部
 */
app.get("/api/audit/tail", requireAdminApi, (req: Request, res: Response) => {
  const n = Math.min(parseInt((req.query.n as string) ?? "50", 10), 500);
  try {
    const rows = db.prepare(
      "SELECT id, ts, action, operator, target, details FROM audit_log ORDER BY id DESC LIMIT ?"
    ).all(n) as any[];
    res.json({ entries: rows });
  } catch {
    res.json({ entries: [] });
  }
});

// 挂载 Dashboard 静态资源（同时提供 / 和 /dashboard 入口）
app.use("/dashboard", requireAdminApi, createDashboardRouter());
app.get("/", (_req, res) => res.redirect("/dashboard"));

// HUB_VERSION 由 ./version.js 统一从 package.json 读取（单一真相源）

// ═══════════════════════════════════════════════════════════════
// MCP 端点：Stateless 模式
// ═══════════════════════════════════════════════════════════════

function createMcpServer(authContext: AuthContext | undefined): McpServer {
  const server = new McpServer({
    name: "agent-comm-hub",
    version: HUB_VERSION,
  });
  registerTools(server, authContext);
  return server;
}

function extractToolName(req: express.Request): string | null {
  try {
    const body = req.body;
    if (body?.method === "tools/call" && body?.params?.name) {
      return body.params.name as string;
    }
  } catch (err) { logError("extract_tool_name_failed", err, { module: "mcp" }); }
  return null;
}

// POST /mcp
app.post("/mcp", optionalAuthMiddleware, async (req: Request, res: Response) => {
  const authContext: AuthContext | undefined = req.auth?.agent
    ? { agentId: req.auth.agent.agentId, role: req.auth.agent.role }
    : undefined;

  if (authContext) {
    if (!rateLimiter(authContext.agentId)) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Rate limit exceeded (10 req/s)" },
        id: null,
      });
      return;
    }
  }

  const server = createMcpServer(authContext);
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
    logError("[MCP] handleRequest error", error, { module: "mcp", traceId: (req as any).traceId });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp
app.get("/mcp", optionalAuthMiddleware, async (req: Request, res: Response) => {
  const authContext: AuthContext | undefined = req.auth?.agent
    ? { agentId: req.auth.agent.agentId, role: req.auth.agent.role }
    : undefined;

  const server = createMcpServer(authContext);
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
    logError("[MCP] GET /mcp error", error, { module: "mcp", traceId: (req as any).traceId });
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

// DELETE /mcp
app.delete("/mcp", optionalAuthMiddleware, async (req: Request, res: Response) => {
  const authContext: AuthContext | undefined = req.auth?.agent
    ? { agentId: req.auth.agent.agentId, role: req.auth.agent.role }
    : undefined;

  const server = createMcpServer(authContext);
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
    logError("[MCP] DELETE /mcp error", error, { module: "mcp", traceId: (req as any).traceId });
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 404 处理（在 error handler 之前）
// ═══════════════════════════════════════════════════════════════
app.use((req: Request, res: Response) => {
  const traceId = (req as any).traceId;
  res.status(404).json({
    error: true,
    message: "Not Found",
    traceId,
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 全局错误处理中间件（放在所有路由之后）
// ═══════════════════════════════════════════════════════════════
app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const traceId = (req as unknown as Record<string, unknown>).traceId as string | undefined;
  logError("unhandled_error", err, { traceId, path: req.path, method: req.method });

  if (res.headersSent) return;

  res.status(err.status || 500).json({
    error: true,
    message: process.env.NODE_ENV === "development" ? err.message : "Internal Server Error",
    traceId,
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 5b: 优雅关闭
// ═══════════════════════════════════════════════════════════════

let httpServer: ReturnType<typeof app.listen> | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info("shutdown_initiated", { signal, module: "server" });

  // 1. 停止接受新连接
  if (httpServer) {
    httpServer.close(() => {
      logger.info("http_server_closed", { module: "server" });
    });
  }

  // 2. drain SSE 连接
  drainAllClients();
  logger.info("sse_drained", { module: "server" });

  // 3. 停止定时器
  stopHeartbeatMonitor();
  stopBackupScheduler();
  stopDedupCleanup();
  stopCleanup();
  stopZombieCleanup();

  // 4. 关闭数据库
  try {
    db.close();
    logger.info("database_closed", { module: "server" });
  } catch (err) {
    logError("database_close_error", err, { module: "server" });
  }

  logger.info("shutdown_complete", { module: "server" });
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
// 未捕获异常兜底
// ═══════════════════════════════════════════════════════════════
process.on("uncaughtException", (err: Error) => {
  logError("uncaught_exception", err, { module: "process" });
  process.exit(1);
});

// D6 修复：unhandledRejection 不再“仅日志、带病运行”。
// 累计次数达阈值，或遇到关键/不可恢复错误时，对齐 uncaughtException 退出进程；
// 可恢复错误（未达阈值）不退出。
let unhandledRejectionCount = 0;
const UNHANDLED_REJECTION_LIMIT = parseInt(process.env.UNHANDLED_REJECTION_LIMIT ?? "20", 10);
process.on("unhandledRejection", (reason: unknown) => {
  unhandledRejectionCount++;
  const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  logError("unhandled_rejection", reason, { module: "process", count: unhandledRejectionCount });
  // 关键/不可恢复错误（如数据库、文件系统、网络）立即退出
  const critical = /EACCES|EADDRINUSE|ECONNREFUSED|ENOTFOUND|SQLITE|database|out of memory|ENOENT/i.test(
    String(reason)
  );
  if (critical || unhandledRejectionCount >= UNHANDLED_REJECTION_LIMIT) {
    logger.error("unhandled_rejection_fatal", {
      module: "process",
      count: unhandledRejectionCount,
      reason: message,
    });
    process.exit(1);
  }
});

// ═══════════════════════════════════════════════════════════════
// 持久化运行时间（跨重启）
// ═══════════════════════════════════════════════════════════════

/** 服务器首次启动时间戳（毫秒），跨重启持久化 */
let serverStartTime: number | null = null;

function initServerStartTime(): void {
  try {
    // 确保 config 表存在
    db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT)`);
    const row = db.prepare(`SELECT value FROM server_config WHERE key='hub_first_start'`).get() as any;
    if (row) {
      serverStartTime = parseInt(row.value, 10);
    } else {
      serverStartTime = Date.now();
      db.prepare(`INSERT INTO server_config (key, value) VALUES ('hub_first_start', ?)`).run(String(serverStartTime));
    }
    logger.info("server_start_time_init", {
      module: "server",
      server_start_ms: serverStartTime,
      uptime_s: Math.round((Date.now() - serverStartTime) / 1000),
    });
  } catch (err) {
    logError("server_start_time_init_failed", err, { module: "server" });
  }
}

function getPersistentUptime(): number {
  if (serverStartTime) {
    return (Date.now() - serverStartTime) / 1000; // 秒
  }
  return process.uptime(); // fallback
}

// ═══════════════════════════════════════════════════════════════
// 启动
// ═══════════════════════════════════════════════════════════════

// 启动模式判定（D3 修复）：
// 默认 HTTP 服务；仅当显式设置 MODE=stdio 或传递 --stdio CLI flag 时进入 MCP stdio 模式。
// 不再用 process.stdin.isTTY 推断，避免 `docker run -d`（无 TTY）误激活 stdio 分支而崩溃。
const stdioMode = process.env.MODE === "stdio" || process.argv.includes("--stdio");
if (stdioMode) {
  // 异步加载 stdio 模式
  const { startMcpStdio } = await import("./stdio.js");
  startMcpStdio().catch((err: unknown) => {
    logError("stdio_init_failed", err, { module: "server" });
    process.exit(1);
  });
}

initServerStartTime();

httpServer = app.listen(config.port, () => {
  logger.info("server_started", {
    module: "server",
    version: HUB_VERSION,
    port: config.port,
    phase: "5b",
  });

  // 启动心跳超时监控
  startHeartbeatMonitor((agentId) => {
    logger.info("agent_offline_timeout", { module: "monitor", agent_id: agentId });
  });

  // 启动数据库定时备份
  startBackupScheduler(config.dbPath);

  // 启动去重缓存 TTL 清理（15min）
  startDedupCleanup();

  // Phase 6: 启动定时清理（过期 Token / Dedup / Consumed）
  scheduleCleanup(config.dedupTTL);

  // P2-3: SSE 僵尸连接清理（5分钟检测，10分钟超时）
  startZombieCleanup();

  // 重建 FTS 索引
  rebuildFtsIndex();
});

// 优雅关闭信号监听
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
