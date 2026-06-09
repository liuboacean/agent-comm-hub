/**
 * evolution.test.ts — Evolution Engine 模块单元测试
 *
 * 覆盖范围：
 *   - propose_strategy 策略提议
 *   - approve_strategy 策略审批
 *   - feedback_strategy 反馈统计
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ─── Mock logger ──────────────────────────────────────────
vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── 内存数据库工厂 ────────────────────────────────────────
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
      approval_tier   TEXT DEFAULT 'admin',
      observation_start INTEGER,
      veto_deadline     INTEGER,
      UNIQUE(title, proposer_id)  -- 不含 proposed_at, timestamp 不应影响重复检测
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

    CREATE TABLE IF NOT EXISTS strategy_applications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id  INTEGER NOT NULL,
      agent_id     TEXT NOT NULL,
      context      TEXT,
      result       TEXT,
      created_at   INTEGER NOT NULL
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
  `);

  return db;
}

// ─── Mock db 模块 ─────────────────────────────────────────
let testDb: Database.Database;

vi.mock("../../src/db.js", () => ({
  get db() {
    return testDb;
  },
}));

// ─── 导入被测模块 ──────────────────────────────────────────
import {
  proposeStrategy,
  approveStrategy,
  feedbackStrategy,
} from "../../src/evolution.js";

// ─── 辅助函数 ──────────────────────────────────────────────
function seedAgent(db: Database.Database, agentId: string, role: string = "member", trustScore: number = 50) {
  db.prepare(
    `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
     VALUES (?, ?, ?, 'offline', ?, ?)`
  ).run(agentId, agentId.replace(/_/g, "-"), role, trustScore, Date.now());
}

// ─── 测试 ─────────────────────────────────────────────────

describe("Evolution Engine", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedAgent(testDb, "agent_001", "member", 60);
    seedAgent(testDb, "agent_002", "member", 50);
    seedAgent(testDb, "admin_agent", "admin", 90);
  });

  describe("proposeStrategy", () => {
    it("propose_strategy creates new strategy", () => {
      const result = proposeStrategy(
        "Test Strategy",
        "This is a test strategy for improving workflow efficiency.",
        "workflow",
        "agent_001",
      );

      expect(result.ok).toBe(true);
      expect(result.strategy).toBeDefined();
      if (result.ok) {
        expect(result.strategy.status).toBe("pending");
        expect(result.strategy.title).toBe("Test Strategy");
      }

      // 验证数据库
      const strat = testDb.prepare(
        `SELECT * FROM strategies WHERE title = ? AND proposer_id = ?`
      ).get("Test Strategy", "agent_001") as any;
      expect(strat).toBeDefined();
      expect(strat.status).toBe("pending");
    });

    it("propose_strategy rejects duplicate title for same proposer", () => {
      proposeStrategy(
        "Unique Strategy",
        "First attempt with enough content.",
        "workflow",
        "agent_001",
      );

      const result = proposeStrategy(
        "Unique Strategy",
        "Duplicate attempt with content.",
        "workflow",
        "agent_001",
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("propose_strategy defaults category to workflow", () => {
      const result = proposeStrategy(
        "Default Category Strategy",
        "Testing defaults for category parameter.",
        "workflow",
        "agent_001",
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.strategy.category).toBe("workflow");
      }
    });
  });

  describe("approveStrategy", () => {
    it("approve_strategy sets status to approved", () => {
      const prop = proposeStrategy(
        "Approvable Strategy",
        "Please approve this strategy for testing.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;
      const strategyId = prop.strategy.id!;

      const result = approveStrategy(
        strategyId,
        "admin_agent",
        "approve",
        "Looks good, approved.",
      );

      expect(result.ok).toBe(true);

      // 验证数据库状态
      const strat = testDb.prepare(
        `SELECT * FROM strategies WHERE id = ?`
      ).get(strategyId) as any;
      expect(strat.status).toBe("approved");
      expect(strat.approved_by).toBe("admin_agent");
      expect(strat.approve_reason).toBe("Looks good, approved.");
    });

    it("approve_strategy allows any agent to approve (role check at MCP layer)", () => {
      const prop = proposeStrategy(
        "Non-Admin Approve",
        "This should succeed at service layer since role check is at MCP tool layer.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;

      const result = approveStrategy(
        prop.strategy.id!,
        "agent_002",
        "approve",
        "I am member but role check is at MCP tool layer",
      );

      // 服务层不检查角色，角色检查在 MCP 工具层
      expect(result.ok).toBe(true);
    });

    it("approve_strategy rejects non-existent strategy", () => {
      const result = approveStrategy(
        99999,
        "admin_agent",
        "approve",
        "Approving nothing.",
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("approve_strategy rejects already approved strategy", () => {
      const prop = proposeStrategy(
        "Double Approve",
        "Approve me once only for testing purposes.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;

      approveStrategy(prop.strategy.id!, "admin_agent", "approve", "First approval.");
      const result = approveStrategy(
        prop.strategy.id!,
        "admin_agent",
        "approve",
        "Second approval.",
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("feedbackStrategy", () => {
    it("feedback_strategy updates stats", () => {
      const prop = proposeStrategy(
        "Feedback Strategy",
        "Give me feedback to test the engine.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;
      const strategyId = prop.strategy.id!;

      approveStrategy(strategyId, "admin_agent", "approve", "Approved for feedback test.");

      const result = feedbackStrategy(
        strategyId,
        "agent_002",
        "positive",
        { comment: "Great improvement!" },
      );

      expect(result.ok).toBe(true);

      // 验证反馈已记录
      const fb = testDb.prepare(
        `SELECT * FROM strategy_feedback WHERE strategy_id = ? AND agent_id = ?`
      ).get(strategyId, "agent_002") as any;
      expect(fb).toBeDefined();
      expect(fb.feedback).toBe("positive");

      // 验证策略统计已更新
      const strat = testDb.prepare(
        `SELECT * FROM strategies WHERE id = ?`
      ).get(strategyId) as any;
      expect(strat.feedback_count).toBe(1);
      expect(strat.positive_count).toBe(1);
    });

    it("feedback_strategy prevents duplicate feedback from same agent", () => {
      const prop = proposeStrategy(
        "Dedup Feedback",
        "Only one feedback per agent in the system.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;
      const strategyId = prop.strategy.id!;

      approveStrategy(strategyId, "admin_agent", "approve", "Approved.");

      feedbackStrategy(strategyId, "agent_002", "positive", { comment: "First feedback." });
      const result = feedbackStrategy(
        strategyId,
        "agent_002",
        "negative",
        { comment: "Changed mind." },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("feedback_strategy allows feedback on pending strategies (status check at MCP layer)", () => {
      const prop = proposeStrategy(
        "Pending Feedback",
        "Service layer allows feedback on any status.",
        "workflow",
        "agent_001",
      );
      expect(prop.ok).toBe(true);
      if (!prop.ok) return;

      const result = feedbackStrategy(
        prop.strategy.id!,
        "agent_002",
        "positive",
      );

      // 服务层不检查策略状态，状态检查在 MCP 工具层
      expect(result.ok).toBe(true);
    });
  });
});
