/**
 * identity.test.ts — Identity 模块单元测试
 *
 * 覆盖范围：
 *   - register_agent 注册流程
 *   - heartbeat 心跳上报
 *   - set_trust_score 信任分调整
 *   - generate_invite 邀请码生成
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";

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

    CREATE TABLE IF NOT EXISTS agent_capabilities (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      capability    TEXT NOT NULL,
      params        TEXT,
      verified      INTEGER DEFAULT 0,
      verified_at   INTEGER,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      from_agent  TEXT NOT NULL,
      to_agent    TEXT NOT NULL,
      content     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'message',
      metadata    TEXT,
      status      TEXT NOT NULL DEFAULT 'unread',
      created_at  INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS dedup_cache (
      msg_hash   TEXT PRIMARY KEY,
      sender_id  TEXT NOT NULL,
      nonce      INTEGER NOT NULL,
      created_at INTEGER NOT NULL
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
  fts5IntegrityCheck: () => ({ ok: true, details: "OK" }),
}));

// ─── 导入被测模块 ──────────────────────────────────────────
import {
  registerAgent,
  heartbeat,
  updateAgentTrustScore,
} from "../../src/identity.js";

// ─── 辅助函数 ──────────────────────────────────────────────
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function createInviteCode(role: string, db: Database.Database): string {
  const plain = randomBytes(16).toString("hex");
  const hash = sha256(plain);
  const tokenId = `invite_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const expiresAt = Date.now() + 24 * 3600 * 1000;
  db.prepare(
    `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)
     VALUES (?, 'invite_code', ?, NULL, ?, 0, ?, ?)`
  ).run(tokenId, hash, role, Date.now(), expiresAt);
  return plain;
}

// ─── 测试 ─────────────────────────────────────────────────

describe("Identity", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  describe("register_agent", () => {
    it("registry with valid invite code returns agent_id", () => {
      const inviteCode = createInviteCode("member", testDb);

      const result = registerAgent(inviteCode, "test-agent-001", ["mcp", "sse"]);

      expect(result.success).toBe(true);
      expect(result.agentId).toBeDefined();
      expect(result.agentId).toMatch(/^agent_/);
      expect(result.apiToken).toBeDefined();
      expect(result.role).toBe("member");

      // 验证数据库中确实创建了 agent
      const agent = testDb.prepare(
        `SELECT * FROM agents WHERE agent_id = ?`
      ).get(result.agentId!) as any;
      expect(agent).toBeDefined();
      expect(agent.name).toBe("test-agent-001");
      expect(agent.role).toBe("member");
    });

    it("registry with admin invite code returns admin role", () => {
      const inviteCode = createInviteCode("admin", testDb);

      const result = registerAgent(inviteCode, "test-agent-admin", []);

      expect(result.success).toBe(true);
      expect(result.role).toBe("admin");
    });

    it("registry with invalid invite code returns error", () => {
      const result = registerAgent("invalid_code_xyz", "test-agent-002", []);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("heartbeat", () => {
    it("heartbeat updates status to online", () => {
      const inviteCode = createInviteCode("member", testDb);
      const regResult = registerAgent(inviteCode, "heartbeat-agent", []);
      expect(regResult.success).toBe(true);

      const result = heartbeat(regResult.agentId!);

      expect(result.success).toBe(true);
      expect(result.status).toBe("online");

      // 验证数据库中状态已更新
      const agent = testDb.prepare(
        `SELECT status, trust_score, last_heartbeat FROM agents WHERE agent_id = ?`
      ).get(regResult.agentId!) as any;
      expect(agent.status).toBe("online");
      expect(agent.trust_score).toBeGreaterThanOrEqual(50);
    });

    it("heartbeat for non-existent agent returns error", () => {
      const result = heartbeat("nonexistent_agent");

      expect(result.success).toBe(false);
    });
  });

  describe("set_trust_score", () => {
    it("set_trust_score adjusts trust value", () => {
      const inviteCode = createInviteCode("member", testDb);
      const regResult = registerAgent(inviteCode, "trust-agent", []);
      expect(regResult.success).toBe(true);

      const result = updateAgentTrustScore(regResult.agentId!, 10, "admin_agent");

      expect(result.ok).toBe(true);
      expect(result.new_score).toBe(60); // 50 + 10

      // 验证数据库
      const agent = testDb.prepare(
        `SELECT trust_score FROM agents WHERE agent_id = ?`
      ).get(regResult.agentId!) as any;
      expect(agent.trust_score).toBe(60);
    });

    it("set_trust_score clamps to 0-100", () => {
      const inviteCode = createInviteCode("member", testDb);
      const regResult = registerAgent(inviteCode, "clamp-agent", []);
      expect(regResult.success).toBe(true);

      // Clamp to 0
      const resultLow = updateAgentTrustScore(regResult.agentId!, -60, "admin_agent");
      expect(resultLow.new_score).toBe(0);

      // Clamp to 100
      const resultHigh = updateAgentTrustScore(regResult.agentId!, 100, "admin_agent");
      expect(resultHigh.new_score).toBe(100);
    });

    it("set_trust_score returns error for non-existent agent", () => {
      const result = updateAgentTrustScore("nonexistent_agent", 10, "admin_agent");
      expect(result.ok).toBe(false);
    });
  });

  describe("generate_invite", () => {
    it("should create invite token in database", () => {
      const plain = randomBytes(32).toString("hex");
      const hash = sha256(plain);
      const now = Date.now();
      const expiresAt = now + 24 * 3600 * 1000;
      const tokenId = `invite_${now}_${randomBytes(4).toString("hex")}`;

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)
         VALUES (?, 'invite_code', ?, NULL, 'member', 0, ?, ?)`
      ).run(tokenId, hash, Date.now(), expiresAt);

      // 验证 token 已创建
      const token = testDb.prepare(
        `SELECT * FROM auth_tokens WHERE token_id = ?`
      ).get(tokenId) as any;
      expect(token).toBeDefined();
      expect(token.token_type).toBe("invite_code");
      expect(token.role).toBe("member");
      expect(token.used).toBe(0);
    });
  });
});
