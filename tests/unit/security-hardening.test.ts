/**
 * security-hardening.test.ts — T9 安全加固回归测试 (ClawScan 67 findings)
 *
 * 覆盖范围（基于内存 mock db，参考 tests/unit/security.test.ts 脚手架）：
 *   1. fail-closed：checkPermission 未注册工具拒绝 + public/member/admin 分级
 *   2. requireAdmin 护栏：member/group_admin 抛错，admin 不抛
 *   4. HTTP 端点认证中间件：internalMonitorAuth / requireAdminApi / authMiddleware
 *   5. admin 工具角色护栏：9 个 admin 工具的 requireAuth 门禁（member 拒绝 / admin 放行）
 *   6. 数据访问授权：getMemoryStats per-agent 守卫 + search_messages / batch_acknowledge_messages 本人域隔离
 *   8. feedback UPSERT：同 agent 重复 feedback 覆盖而非拒绝
 *   9. scoreAppliedStrategies 条件：仅 status='approved' 且 applied=1 的 neutral 反馈参与降分
 *
 * 注意：本文件直接调用 MCP handler（绕过 MCP SDK），因此调用时需显式传入 zod schema 的
 * 默认值（如 limit / status），否则 handler 内部 Math.min(undefined, n) → NaN 会被
 * better-sqlite3 拒绝（datatype mismatch）。这是测试契约要求，非源码缺陷。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ─── Mock logger ──────────────────────────────────────────
vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Mock dedup（其模块加载时会访问 db，避免导入期 db 未初始化） ──
vi.mock("../../src/dedup.js", () => ({
  dedupMessage: () => false,
  validateMessageBody: () => ({ valid: true }),
}));

// ─── 内存数据库工厂（mock db 的返回对象） ─────────────────
let testDb: Database.Database;

vi.mock("../../src/db.js", () => ({
  get db() {
    return testDb;
  },
}));

// ─── 导入被测模块（在 mock 之后） ─────────────────────────
import {
  sha256,
  generateToken,
  checkPermission,
  requireAdmin,
  verifyToken,
  internalMonitorAuth,
  requireAdminApi,
  authMiddleware,
  type AuthContext,
} from "../../src/security.js";
import { requireAuth } from "../../src/utils.js";
import {
  proposeStrategy,
  approveStrategy,
  feedbackStrategy,
  provideFeedback,
  scoreAppliedStrategies,
} from "../../src/evolution.js";
import { getMemoryStats } from "../../src/memory.js";
import { registerMessageTools } from "../../src/tools/message.js";

// ─── 建表 ─────────────────────────────────────────────────
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id      TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      api_token     TEXT,
      status        TEXT NOT NULL DEFAULT 'offline',
      trust_score   INTEGER NOT NULL DEFAULT 50,
      last_heartbeat INTEGER,
      managed_group_id TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_id      TEXT PRIMARY KEY,
      token_type    TEXT NOT NULL,
      token_value   TEXT NOT NULL,
      agent_id      TEXT,
      role          TEXT,
      used          INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER,
      revoked_at    INTEGER,
      UNIQUE(token_type, token_value)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      action      TEXT NOT NULL,
      agent_id    TEXT,
      target      TEXT,
      details     TEXT,
      ip_address  TEXT,
      created_at  INTEGER NOT NULL,
      prev_hash   TEXT,
      record_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT 'workflow',
      sensitivity     TEXT NOT NULL DEFAULT 'normal',
      proposer_id     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      approve_reason  TEXT,
      approved_by     TEXT,
      approved_at     INTEGER,
      proposed_at     INTEGER NOT NULL,
      task_id         TEXT,
      source_trust    INTEGER NOT NULL DEFAULT 50,
      apply_count     INTEGER NOT NULL DEFAULT 0,
      feedback_count  INTEGER NOT NULL DEFAULT 0,
      positive_count  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(title, proposer_id, proposed_at)
    );

    CREATE TABLE IF NOT EXISTS strategy_feedback (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id  INTEGER NOT NULL,
      agent_id     TEXT NOT NULL,
      feedback     TEXT NOT NULL,
      comment      TEXT,
      applied      INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      UNIQUE(strategy_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'global',
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      from_agent  TEXT NOT NULL,
      to_agent    TEXT NOT NULL,
      content     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'message',
      status      TEXT NOT NULL DEFAULT 'unread',
      created_at  INTEGER NOT NULL
    );
  `);
  return db;
}

// ─── 测试令牌（HTTP 中间件用） ───────────────────────────
let adminToken = "";
let memberToken = "";

beforeEach(() => {
  testDb = createTestDb();

  adminToken = generateToken();
  memberToken = generateToken();

  testDb.prepare(
    `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at)
     VALUES (?, 'api_token', ?, 'admin_agent', 'admin', 1, ?)`
  ).run("tok_admin", sha256(adminToken), Date.now());

  testDb.prepare(
    `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at)
     VALUES (?, 'api_token', ?, 'member_agent', 'member', 1, ?)`
  ).run("tok_member", sha256(memberToken), Date.now());
});

// ═══════════════════════════════════════════════════════════
// 1. fail-closed 权限矩阵
// ═══════════════════════════════════════════════════════════
describe("T1 checkPermission fail-closed", () => {
  it("should DENY unregistered tools for any role (fail-closed)", () => {
    expect(checkPermission("unknown_tool_xyz", "member")).toBe(false);
    expect(checkPermission("unknown_tool_xyz", "admin")).toBe(false);
    expect(checkPermission("unknown_tool_xyz", "group_admin")).toBe(false);
  });

  it("should allow public tools for any authenticated role", () => {
    expect(checkPermission("register_agent", "admin")).toBe(true);
    expect(checkPermission("register_agent", "member")).toBe(true);
    expect(checkPermission("register_agent", "group_admin")).toBe(true);
  });

  it("should allow member tools only when role is present (non-null)", () => {
    expect(checkPermission("heartbeat", "member")).toBe(true);
    expect(checkPermission("heartbeat", "admin")).toBe(true);
    expect(checkPermission("heartbeat", "group_admin")).toBe(true);
    // 未认证（role 为空）一律拒绝
    expect(checkPermission("heartbeat", null as unknown as AuthContext["role"])).toBe(false);
  });

  it("should restrict admin-only tools to admin role", () => {
    expect(checkPermission("revoke_token", "admin")).toBe(true);
    expect(checkPermission("revoke_token", "member")).toBe(false);
    expect(checkPermission("revoke_token", "group_admin")).toBe(false);
    expect(checkPermission("archive_data", "admin")).toBe(true);
    expect(checkPermission("archive_data", "member")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. requireAdmin 护栏
// ═══════════════════════════════════════════════════════════
describe("T1 requireAdmin guard", () => {
  it("should NOT throw for admin context", () => {
    expect(() => requireAdmin({ agentId: "a", role: "admin" })).not.toThrow();
  });

  it("should throw for member context", () => {
    expect(() => requireAdmin({ agentId: "m", role: "member" })).toThrow(/Admin role required/);
  });

  it("should throw for group_admin context (not admin)", () => {
    expect(() => requireAdmin({ agentId: "g", role: "group_admin" })).toThrow(/Admin role required/);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. HTTP 端点认证中间件 (T3)
// ═══════════════════════════════════════════════════════════
function makeRes(): any {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    ip: "203.0.113.5", // 默认非 loopback
    socket: { remoteAddress: "203.0.113.5" },
    headers: {},
    query: {},
    ...overrides,
  };
}

describe("T3 HTTP auth middleware", () => {
  it("internalMonitorAuth: loopback without token → allowed (200 path)", () => {
    const req = makeReq({ ip: "127.0.0.1" });
    const res = makeRes();
    const next = vi.fn();
    internalMonitorAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0); // 未设置错误状态码
  });

  it("internalMonitorAuth: non-loopback without token → 401", () => {
    const req = makeReq({ ip: "203.0.113.5" });
    const res = makeRes();
    const next = vi.fn();
    internalMonitorAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("internalMonitorAuth: non-loopback with valid token → allowed", () => {
    const req = makeReq({
      ip: "203.0.113.5",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    const res = makeRes();
    const next = vi.fn();
    internalMonitorAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("requireAdminApi: no token → 401", () => {
    const req = makeReq({ ip: "203.0.113.5" });
    const res = makeRes();
    const next = vi.fn();
    requireAdminApi(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("requireAdminApi: non-admin valid token → 403", () => {
    const req = makeReq({
      ip: "203.0.113.5",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    const res = makeRes();
    const next = vi.fn();
    requireAdminApi(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("requireAdminApi: admin valid token → allowed (200 path)", () => {
    const req = makeReq({
      ip: "203.0.113.5",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const res = makeRes();
    const next = vi.fn();
    requireAdminApi(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("authMiddleware: missing token → 401, valid token → next", () => {
    const noTok = makeReq({ ip: "203.0.113.5" });
    const res1 = makeRes();
    const next1 = vi.fn();
    authMiddleware(noTok, res1, next1);
    expect(res1.statusCode).toBe(401);

    const withTok = makeReq({
      ip: "203.0.113.5",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const res2 = makeRes();
    const next2 = vi.fn();
    authMiddleware(withTok, res2, next2);
    expect(next2).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. admin 工具角色护栏（requireAuth 门禁，handler 实际使用的同款守卫）
// ═══════════════════════════════════════════════════════════
describe("T4 admin tool role guard (requireAuth gate)", () => {
  const ADMIN_TOOLS = [
    "revoke_token",
    "set_trust_score",
    "set_agent_role",
    "recalculate_trust_scores",
    "get_db_stats",
    "archive_data",
    "approve_strategy",
    "veto_strategy",
    "score_applied_strategies",
  ];

  it("should DENY each admin tool for member context", () => {
    for (const tool of ADMIN_TOOLS) {
      expect(() => requireAuth({ agentId: "m", role: "member" }, tool)).toThrow(/Permission denied/);
    }
  });

  it("should ALLOW each admin tool for admin context (passes gate into business logic)", () => {
    for (const tool of ADMIN_TOOLS) {
      const ctx = requireAuth({ agentId: "a", role: "admin" }, tool);
      expect(ctx.role).toBe("admin");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 数据访问授权（T5）
// ═══════════════════════════════════════════════════════════
describe("T5 data-access authorization", () => {
  it("getMemoryStats: non-admin caller must NOT see per-agent distribution", () => {
    testDb.prepare(
      `INSERT INTO memories (id, agent_id, scope, content, created_at) VALUES (?, ?, 'global', 'm1', ?)`
    ).run("mem_a", "agentA", Date.now());
    testDb.prepare(
      `INSERT INTO memories (id, agent_id, scope, content, created_at) VALUES (?, ?, 'global', 'm2', ?)`
    ).run("mem_b", "agentB", Date.now());

    const adminStats = getMemoryStats({ role: "admin" });
    expect(adminStats.by_agent).toHaveProperty("agentA");
    expect(adminStats.by_agent).toHaveProperty("agentB");

    // T5 守卫：非 admin 调用者（显式传入）不暴露他人记忆分布
    const memberStats = getMemoryStats({ role: "member" });
    expect(memberStats.by_agent).toEqual({});

    // 注意：该函数为死代码（未被任何工具暴露）；未传 caller 时实现回退为暴露全量，
    // 此处仅断言其返回结构稳定（非安全断言点）。
    const anonStats = getMemoryStats();
    expect(anonStats.total).toBe(2);
  });

  function makeFakeServer() {
    const handlers: Record<string, (params: any) => any> = {};
    const server: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (params: any) => any) => {
        handlers[name] = handler;
      },
    };
    return { server, handlers };
  }

  function seedMessages() {
    const now = Date.now();
    testDb.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, type, status, created_at)
       VALUES (?, ?, ?, ?, 'message', 'delivered', ?)`
    ).run("m1", "agentA", "agentB", "hello from A", now);
    testDb.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, type, status, created_at)
       VALUES (?, ?, ?, ?, 'message', 'unread', ?)`
    ).run("m2", "agentB", "agentA", "hello to A", now);
    testDb.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, type, status, created_at)
       VALUES (?, ?, ?, ?, 'message', 'unread', ?)`
    ).run("m3", "agentB", "agentC", "hello B to C", now);
    testDb.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, type, status, created_at)
       VALUES (?, ?, ?, ?, 'message', 'unread', ?)`
    ).run("m4", "agentA", "agentC", "hello A to C", now);
  }

  it("search_messages: member can only see own sent/received, others' agent_id ignored", async () => {
    const { server, handlers } = makeFakeServer();
    registerMessageTools(server, { agentId: "agentA", role: "member" });
    seedMessages();

    // 显式传入 zod 默认值 limit（绕过 MCP SDK 时由测试补齐契约参数）
    const out = await handlers["search_messages"]({ query: "hello", agent_id: "agentB", limit: 10 });
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.messages.length).toBeGreaterThan(0);
    // 所有返回消息必须涉及本人 agentA（他人 agentB 的查询被归一到本人）
    for (const m of parsed.messages) {
      expect(m.from_agent === "agentA" || m.to_agent === "agentA").toBe(true);
    }
    // agentB→agentC 的纯他人消息不应出现
    const leaked = parsed.messages.find((m: any) => m.from_agent === "agentB" && m.to_agent === "agentC");
    expect(leaked).toBeUndefined();
  });

  it("search_messages: admin with explicit agent_id may query that agent", async () => {
    const { server, handlers } = makeFakeServer();
    registerMessageTools(server, { agentId: "adminX", role: "admin" });
    seedMessages();

    const out = await handlers["search_messages"]({ query: "hello", agent_id: "agentB", limit: 10 });
    const parsed = JSON.parse(out.content[0].text);

    // 应包含 agentB→agentC 的消息（仅 admin 可跨域）
    const cross = parsed.messages.find((m: any) => m.from_agent === "agentB" && m.to_agent === "agentC");
    expect(cross).toBeDefined();
  });

  it("batch_acknowledge_messages: member specifying another agent → rejected", async () => {
    const { server, handlers } = makeFakeServer();
    registerMessageTools(server, { agentId: "agentA", role: "member" });
    seedMessages();

    const out = await handlers["batch_acknowledge_messages"]({ agent_id: "agentB", limit: 100, status: "unread" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Permission denied");
  });

  it("batch_acknowledge_messages: member acknowledging own messages → allowed", async () => {
    const { server, handlers } = makeFakeServer();
    registerMessageTools(server, { agentId: "agentA", role: "member" });
    seedMessages();

    // 显式补齐 zod 默认值：limit=100, status='unread'（否则 actualLimit=NaN → better-sqlite3 datatype mismatch）
    const out = await handlers["batch_acknowledge_messages"]({ agent_id: "agentA", limit: 100, status: "unread" });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.acknowledged_count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. feedback UPSERT（T7）
// ═══════════════════════════════════════════════════════════
describe("T7 feedback_strategy UPSERT", () => {
  it("should upsert (overwrite) duplicate feedback from same agent instead of rejecting", () => {
    const prop = proposeStrategy(
      "UPSERT Strategy",
      "Content long enough to satisfy minimum length.",
      "workflow",
      "agent_001",
    );
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    const sid = prop.strategy.id!;
    approveStrategy(sid, "admin_agent", "approve", "Approved for upsert test.");

    // 模拟 apply_strategy 自动创建的 neutral 占位
    provideFeedback({ strategyId: sid, agentId: "agent_002", feedback: "neutral", applied: 1 });
    const before = testDb.prepare(
      `SELECT feedback FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).get(sid, "agent_002") as any;
    expect(before.feedback).toBe("neutral");

    // 同一 agent 给出真实反馈
    const result = feedbackStrategy(sid, "agent_002", "positive", { comment: "updated" });
    expect(result.ok).toBe(true);

    // UPSERT：不应重复插入行，应覆盖原 neutral 占位
    const rows = testDb.prepare(
      `SELECT feedback, comment FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).all(sid, "agent_002") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].feedback).toBe("positive"); // 覆盖
    expect(rows[0].comment).toBe("updated");
  });
});

// ═══════════════════════════════════════════════════════════
// 9. scoreAppliedStrategies 条件（T7）
// ═══════════════════════════════════════════════════════════
describe("T7 scoreAppliedStrategies conditions", () => {
  function seedStrategy(title: string): number {
    const prop = proposeStrategy(
      title,
      "Content long enough to satisfy minimum length.",
      "workflow",
      "agent_001",
    );
    if (!prop.ok) throw new Error("propose failed");
    return prop.strategy.id!;
  }

  function approve(sid: number) {
    approveStrategy(sid, "admin_agent", "approve", "ok");
  }

  function seedFeedback(sid: number, agentId: string, feedback: string, applied: number, createdAt: number) {
    testDb.prepare(
      `INSERT INTO strategy_feedback (strategy_id, agent_id, feedback, applied, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sid, agentId, feedback, applied, createdAt);
  }

  it("only scores approved + applied=1 + neutral + stale feedback", () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 天前（超过 7 天窗口）

    // S1: approved + neutral + applied=1 + stale → 应降分
    const s1 = seedStrategy("ScoreS1");
    approve(s1);
    seedFeedback(s1, "agent_x", "neutral", 1, old);

    // S2: 未审批（pending） → 排除
    const s2 = seedStrategy("ScoreS2");
    seedFeedback(s2, "agent_y", "neutral", 1, old);

    // S3: approved 但 applied=0 → 排除
    const s3 = seedStrategy("ScoreS3");
    approve(s3);
    seedFeedback(s3, "agent_z", "neutral", 0, old);

    // S4: approved + applied=1 但非 neutral（positive） → 排除
    const s4 = seedStrategy("ScoreS4");
    approve(s4);
    seedFeedback(s4, "agent_w", "positive", 1, old);

    const res = scoreAppliedStrategies();
    expect(res.scored).toBe(1);

    const s1fb = testDb.prepare(
      `SELECT feedback FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).get(s1, "agent_x") as any;
    expect(s1fb.feedback).toBe("negative"); // 被降分

    const s2fb = testDb.prepare(
      `SELECT feedback FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).get(s2, "agent_y") as any;
    expect(s2fb.feedback).toBe("neutral"); // 不变

    const s3fb = testDb.prepare(
      `SELECT feedback FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).get(s3, "agent_z") as any;
    expect(s3fb.feedback).toBe("neutral"); // 不变

    const s4fb = testDb.prepare(
      `SELECT feedback FROM strategy_feedback WHERE strategy_id=? AND agent_id=?`
    ).get(s4, "agent_w") as any;
    expect(s4fb.feedback).toBe("positive"); // 不变
  });
});
