/**
 * security.test.ts — Security 模块单元测试
 *
 * 覆盖范围：
 *   - 纯函数：sha256, generateToken, checkPermission, getRequiredPermission, rateLimiter, sanitizePath
 *   - DB 函数：verifyToken, auditLog, verifyAuditChain, recalculateTrustScore
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

  // 创建测试所需的表
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

    CREATE TABLE IF NOT EXISTS agent_capabilities (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      capability    TEXT NOT NULL,
      params        TEXT,
      verified      INTEGER DEFAULT 0,
      verified_at   INTEGER,
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

// ─── 在所有导入 db 的模块之前获取模块引用 ─────────────────
// 注意：vi.mock 是 hoisted 的，但 testDb 赋值必须在动态导入之前
// 我们使用 vi.hoisted 来设置 testDb
vi.hoisted(() => {
  // testDb 会在 beforeEach 中赋值
});

// 导入被测模块（在 mock 之后）
import {
  sha256,
  generateToken,
  checkPermission,
  getRequiredPermission,
  rateLimiter,
  sanitizePath,
  TOOL_PERMISSIONS,
  verifyToken,
  revokeToken,
  auditLog,
  verifyAuditChain,
  recalculateTrustScore,
  recalculateAllTrustScores,
  generateInviteCode,
  verifyInviteCode,
  markInviteCodeUsed,
  createInviteCode,
} from "../../src/security.js";

// ─── 测试 ─────────────────────────────────────────────────

describe("security.ts", () => {
  beforeEach(() => {
    testDb = createTestDb();
    // 清除速率限制 Map 的副作用 — 无法直接访问 rateLimitMap，
    // 但不同测试用不同 agentId 隔离
  });

  // ═══════════════════════════════════════════════════════════
  // 纯函数测试（不需要数据库）
  // ═══════════════════════════════════════════════════════════

  describe("sha256", () => {
    it("should produce consistent hash for same input", () => {
      const hash1 = sha256("hello");
      const hash2 = sha256("hello");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = sha256("hello");
      const hash2 = sha256("world");
      expect(hash1).not.toBe(hash2);
    });

    it("should produce 64-character hex string", () => {
      const hash = sha256("test");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should handle empty string", () => {
      const hash = sha256("");
      expect(hash).toHaveLength(64);
      // SHA-256 of empty string is a known value
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
  });

  describe("generateToken", () => {
    it("should generate 64-character hex token", () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should generate unique tokens", () => {
      const tokens = new Set(Array.from({ length: 20 }, () => generateToken()));
      expect(tokens.size).toBe(20);
    });
  });

  describe("generateInviteCode", () => {
    it("should generate 8-character hex code", () => {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[0-9a-f]{8}$/);
    });

    it("should generate unique codes", () => {
      const codes = new Set(Array.from({ length: 20 }, () => generateInviteCode()));
      expect(codes.size).toBe(20);
    });
  });

  describe("checkPermission", () => {
    it("should allow public tools for any role", () => {
      expect(checkPermission("register_agent", "admin")).toBe(true);
      expect(checkPermission("register_agent", "member")).toBe(true);
      expect(checkPermission("register_agent", "group_admin")).toBe(true);
    });

    it("should allow member tools for all roles", () => {
      expect(checkPermission("heartbeat", "admin")).toBe(true);
      expect(checkPermission("heartbeat", "member")).toBe(true);
      expect(checkPermission("heartbeat", "group_admin")).toBe(true);
    });

    it("should restrict admin-only tools to admin role", () => {
      expect(checkPermission("revoke_token", "admin")).toBe(true);
      expect(checkPermission("revoke_token", "member")).toBe(false);
      expect(checkPermission("revoke_token", "group_admin")).toBe(false);
    });

    it("should allow unregistered tools for any role", () => {
      expect(checkPermission("unknown_tool_xyz", "member")).toBe(true);
      expect(checkPermission("unknown_tool_xyz", "admin")).toBe(true);
    });

    it("should cover all admin-only tools", () => {
      const adminTools = Object.entries(TOOL_PERMISSIONS)
        .filter(([, level]) => level === "admin")
        .map(([name]) => name);

      for (const tool of adminTools) {
        expect(checkPermission(tool, "admin")).toBe(true);
        expect(checkPermission(tool, "member")).toBe(false);
      }
    });

    it("should return false for unknown permission level (defensive branch)", () => {
      // Inject an invalid level to cover the `return false` defensive branch (L169)
      const original = (TOOL_PERMISSIONS as Record<string, string>)["test_unknown_level_tool"];
      (TOOL_PERMISSIONS as Record<string, string>)["test_unknown_level_tool"] = "superadmin";
      try {
        expect(checkPermission("test_unknown_level_tool", "admin")).toBe(false);
        expect(checkPermission("test_unknown_level_tool", "member")).toBe(false);
      } finally {
        if (original === undefined) {
          delete (TOOL_PERMISSIONS as Record<string, string>)["test_unknown_level_tool"];
        } else {
          (TOOL_PERMISSIONS as Record<string, string>)["test_unknown_level_tool"] = original;
        }
      }
    });
  });

  describe("getRequiredPermission", () => {
    it("should return correct permission level", () => {
      expect(getRequiredPermission("register_agent")).toBe("public");
      expect(getRequiredPermission("heartbeat")).toBe("member");
      expect(getRequiredPermission("revoke_token")).toBe("admin");
    });

    it("should return undefined for unregistered tools", () => {
      expect(getRequiredPermission("nonexistent_tool")).toBeUndefined();
    });
  });

  describe("rateLimiter", () => {
    it("should allow first request", () => {
      expect(rateLimiter("agent_test_1")).toBe(true);
    });

    it("should allow up to 10 requests per window", () => {
      const agentId = "agent_rate_test_1";
      for (let i = 0; i < 10; i++) {
        expect(rateLimiter(agentId)).toBe(true);
      }
    });

    it("should block requests exceeding rate limit", () => {
      const agentId = "agent_rate_test_2";
      for (let i = 0; i < 10; i++) {
        rateLimiter(agentId);
      }
      expect(rateLimiter(agentId)).toBe(false);
    });

    it("should isolate rate limits per agent", () => {
      const agent1 = "agent_rate_isolated_1";
      const agent2 = "agent_rate_isolated_2";
      // Exhaust agent1
      for (let i = 0; i < 10; i++) {
        rateLimiter(agent1);
      }
      expect(rateLimiter(agent1)).toBe(false);
      // agent2 should still be allowed
      expect(rateLimiter(agent2)).toBe(true);
    });
  });

  describe("sanitizePath", () => {
    it("should allow safe relative paths", () => {
      expect(sanitizePath("uploads/file.txt")).toBe(true);
      expect(sanitizePath("hello/world.pdf")).toBe(true);
      expect(sanitizePath("a")).toBe(true);
    });

    it("should reject path traversal with ..", () => {
      expect(sanitizePath("../etc/passwd")).toBe(false);
      expect(sanitizePath("foo/../bar")).toBe(false);
      expect(sanitizePath("a/b/../../c")).toBe(false);
    });

    it("should reject absolute paths", () => {
      expect(sanitizePath("/etc/passwd")).toBe(false);
      expect(sanitizePath("/tmp/test")).toBe(false);
    });

    it("should reject paths with NULL byte", () => {
      expect(sanitizePath("file\x00evil")).toBe(false);
    });

    it("should normalize backslashes", () => {
      // Backslash is converted to /, so "foo\\bar" becomes "foo/bar" which is safe
      expect(sanitizePath("foo\\bar")).toBe(true);
      // But "..\\foo" becomes "../foo" which is unsafe
      expect(sanitizePath("..\\foo")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 需要数据库的函数测试
  // ═══════════════════════════════════════════════════════════

  describe("verifyToken", () => {
    it("should return AuthContext for valid token", () => {
      const plainToken = "test_token_abc123";
      const hash = sha256(plainToken);

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at)
         VALUES (?, 'api_token', ?, 'agent_001', 'admin', 1, ?)`
      ).run("token_001", hash, Date.now());

      const ctx = verifyToken(plainToken);
      expect(ctx).toEqual({ agentId: "agent_001", role: "admin" });
    });

    it("should return null for invalid token", () => {
      expect(verifyToken("nonexistent_token")).toBeNull();
    });

    it("should return null for revoked token", () => {
      const plainToken = "revoked_token_xyz";
      const hash = sha256(plainToken);

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, revoked_at)
         VALUES (?, 'api_token', ?, 'agent_002', 'member', 1, ?, ?)`
      ).run("token_revoked", hash, Date.now() - 1000, Date.now() - 500);

      expect(verifyToken(plainToken)).toBeNull();
    });

    it("should return null for expired token", () => {
      const plainToken = "expired_token_xyz";
      const hash = sha256(plainToken);

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)
         VALUES (?, 'api_token', ?, 'agent_003', 'member', 1, ?, ?)`
      ).run("token_expired", hash, Date.now() - 2000, Date.now() - 1000);

      expect(verifyToken(plainToken)).toBeNull();
    });

    it("should return null for unused token (used=0)", () => {
      const plainToken = "unused_token_xyz";
      const hash = sha256(plainToken);

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at)
         VALUES (?, 'api_token', ?, 'agent_004', 'member', 0, ?)`
      ).run("token_unused", hash, Date.now());

      expect(verifyToken(plainToken)).toBeNull();
    });

    it("should accept non-expired token with future expires_at", () => {
      const plainToken = "future_token_xyz";
      const hash = sha256(plainToken);

      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)
         VALUES (?, 'api_token', ?, 'agent_005', 'admin', 1, ?, ?)`
      ).run("token_future", hash, Date.now(), Date.now() + 86400000);

      const ctx = verifyToken(plainToken);
      expect(ctx).toEqual({ agentId: "agent_005", role: "admin" });
    });
  });

  describe("createInviteCode / verifyInviteCode / markInviteCodeUsed", () => {
    it("should create and verify invite code", () => {
      const plain = createInviteCode("admin");
      expect(plain).toHaveLength(8);

      const role = verifyInviteCode(plain);
      expect(role).toBe("admin");
    });

    it("should return null for invalid invite code", () => {
      expect(verifyInviteCode("invalidcode")).toBeNull();
    });

    it("should return null for used invite code after marking", () => {
      const plain = createInviteCode("member");
      expect(verifyInviteCode(plain)).toBe("member");

      markInviteCodeUsed(plain);
      expect(verifyInviteCode(plain)).toBeNull();
    });

    it("should return null for expired invite code", () => {
      const plain = createInviteCode("admin");
      const hash = sha256(plain);
      // 直接更新 expires_at 到过去
      testDb.prepare(
        `UPDATE auth_tokens SET expires_at=? WHERE token_value=? AND token_type='invite_code'`
      ).run(Date.now() - 1000, hash);
      expect(verifyInviteCode(plain)).toBeNull();
    });
  });

  describe("revokeToken", () => {
    it("should revoke an existing api_token and return true", () => {
      const plain = generateToken();
      const hash = sha256(plain);
      testDb.prepare(
        `INSERT INTO auth_tokens (token_id, token_type, token_value, role, used, created_at)
         VALUES (?, 'api_token', ?, 'member', 1, ?)`
      ).run("tok_revoke_1", hash, Date.now());

      const result = revokeToken("tok_revoke_1");
      expect(result).toBe(true);

      // verifyToken 应该返回 null
      expect(verifyToken(plain)).toBeNull();
    });

    it("should return false for non-existent token_id", () => {
      expect(revokeToken("nonexistent_token_id")).toBe(false);
    });

    it("should not revoke invite_code type tokens", () => {
      const plain = createInviteCode("member");
      const hash = sha256(plain);
      const row = testDb.prepare(
        `SELECT token_id FROM auth_tokens WHERE token_value=? AND token_type='invite_code'`
      ).get(hash) as any;

      const result = revokeToken(row.token_id);
      // revokeToken 只操作 api_token，应返回 false
      expect(result).toBe(false);
    });
  });
  describe("auditLog / verifyAuditChain", () => {
    it("should return valid for empty audit log", () => {
      const result = verifyAuditChain();
      expect(result).toEqual({ valid: true, total: 0, checked: 0 });
    });

    it("should maintain valid chain for sequential logs", () => {
      // Use controlled timestamps to avoid same-ms ordering issues
      // We insert directly into DB to control created_at precisely

      function insertAudit(action: string, agentId: string, target: string | null, details: string | null, created_at: number) {
        const lastRow = testDb.prepare(
          `SELECT record_hash FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1`
        ).get() as any;
        const prevHash = lastRow?.record_hash ?? "GENESIS";
        const hashInput = `${prevHash}|${action}|${agentId ?? ""}|${target ?? ""}|${details ?? ""}|${created_at}`;
        const recordHash = createHash("sha256").update(hashInput).digest("hex");
        const id = `audit_${created_at}_${randomBytes(4).toString("hex")}`;
        testDb.prepare(
          `INSERT INTO audit_log (id, action, agent_id, target, details, prev_hash, record_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, action, agentId, target || null, details || null, prevHash, recordHash, created_at);
      }

      const base = Date.now() - 3000;
      insertAudit("action_1", "agent_001", "target_a", "details_x", base);
      insertAudit("action_2", "agent_002", "target_b", "details_y", base + 1);
      insertAudit("action_3", "agent_001", "target_c", null, base + 2);

      const result = verifyAuditChain();
      expect(result.valid).toBe(true);
      expect(result.total).toBe(3);
      expect(result.checked).toBe(3);
    });

    it("should detect tampered record_hash", () => {
      // Insert two records with controlled timestamps
      const base = Date.now() - 2000;

      function insertAudit(action: string, agentId: string, target: string | null, details: string | null, created_at: number) {
        const lastRow = testDb.prepare(
          `SELECT record_hash FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1`
        ).get() as any;
        const prevHash = lastRow?.record_hash ?? "GENESIS";
        const hashInput = `${prevHash}|${action}|${agentId ?? ""}|${target ?? ""}|${details ?? ""}|${created_at}`;
        const recordHash = createHash("sha256").update(hashInput).digest("hex");
        const id = `audit_tamper_${created_at}_${randomBytes(4).toString("hex")}`;
        testDb.prepare(
          `INSERT INTO audit_log (id, action, agent_id, target, details, prev_hash, record_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, action, agentId, target || null, details || null, prevHash, recordHash, created_at);
      }

      insertAudit("action_good", "agent_001", "target_a", "details_x", base);
      insertAudit("action_good", "agent_002", "target_b", "details_y", base + 1);

      // Tamper: change the second record's record_hash
      testDb.prepare(
        `UPDATE audit_log SET record_hash = 'tampered_hash_value' WHERE action = 'action_good' AND agent_id = 'agent_002'`
      ).run();

      const result = verifyAuditChain();
      expect(result.valid).toBe(false);
      expect(result.firstBreak).toBeDefined();
      // firstBreak.actual is the tampered value; firstBreak.expected is the recomputed correct hash
      expect(result.firstBreak!.actual).toBe("tampered_hash_value");
    });

    it("should skip legacy records with null hashes", () => {
      // Insert a legacy record (no hash chain)
      testDb.prepare(
        `INSERT INTO audit_log (id, action, agent_id, target, details, created_at, prev_hash, record_hash)
         VALUES ('legacy_1', 'old_action', 'agent_old', NULL, NULL, ?, NULL, NULL)`
      ).run(Date.now() - 1000);

      // Insert a new record with hash chain via auditLog
      auditLog("new_action", "agent_001", "target_new");

      const result = verifyAuditChain();
      expect(result.valid).toBe(true);
      expect(result.total).toBe(2);
    });

    it("should detect broken chain when prev_hash does not match expected (L391 branch)", () => {
      // Insert a valid first record
      const base = Date.now() - 2000;
      const hashInput1 = `GENESIS|action_p1|agent_001||details_p1|${base}`;
      const recordHash1 = createHash("sha256").update(hashInput1).digest("hex");
      testDb.prepare(
        `INSERT INTO audit_log (id, action, agent_id, target, details, prev_hash, record_hash, created_at)
         VALUES ('ph_1', 'action_p1', 'agent_001', NULL, 'details_p1', 'GENESIS', ?, ?)`
      ).run(recordHash1, base);

      // Insert a second record with a WRONG prev_hash (should be recordHash1 but we put something else)
      const hashInput2 = `${recordHash1}|action_p2|agent_002||details_p2|${base + 1}`;
      const recordHash2 = createHash("sha256").update(hashInput2).digest("hex");
      testDb.prepare(
        `INSERT INTO audit_log (id, action, agent_id, target, details, prev_hash, record_hash, created_at)
         VALUES ('ph_2', 'action_p2', 'agent_002', NULL, 'details_p2', 'WRONG_PREV_HASH', ?, ?)`
      ).run(recordHash2, base + 1);

      const result = verifyAuditChain();
      expect(result.valid).toBe(false);
      expect(result.firstBreak).toBeDefined();
      expect(result.firstBreak!.actual).toBe("WRONG_PREV_HASH");
      expect(result.firstBreak!.expected).toBe(recordHash1);
    });
  });

  describe("recalculateTrustScore", () => {
    it("should return 50 for agent with no data", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_score_1', 'Test', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      const score = recalculateTrustScore("agent_score_1");
      expect(score).toBe(50);
    });

    it("should increase score for verified capabilities", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_score_2', 'Test', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      // 5 verified capabilities → +15
      for (let i = 0; i < 5; i++) {
        testDb.prepare(
          `INSERT INTO agent_capabilities (id, agent_id, capability, verified, created_at)
           VALUES (?, 'agent_score_2', ?, 1, ?)`
        ).run(`cap_id_${i}`, `cap_${i}`, Date.now());
      }

      const score = recalculateTrustScore("agent_score_2");
      expect(score).toBe(65); // 50 + 5*3 = 65
    });

    it("should increase score for approved strategies", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_score_3', 'Test', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      // 3 approved strategies → +6
      for (let i = 0; i < 3; i++) {
        testDb.prepare(
          `INSERT INTO strategies (title, content, proposer_id, status, proposed_at)
           VALUES (?, ?, 'agent_score_3', 'approved', ?)`
        ).run(`strategy_${i}`, `content_${i}`, Date.now() - i * 1000);
      }

      const score = recalculateTrustScore("agent_score_3");
      expect(score).toBe(56); // 50 + 3*2 = 56
    });

    it("should decrease score for negative feedback and revoked tokens", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_score_4', 'Test', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      // Insert a strategy for this agent (auto-increment id = 1)
      const stratResult = testDb.prepare(
        `INSERT INTO strategies (title, content, proposer_id, status, proposed_at)
         VALUES ('strat_neg', 'content', 'agent_score_4', 'approved', ?)`
      ).run(Date.now());
      const stratId = Number(stratResult.lastInsertRowid);

      // 2 negative feedback from other agents → -4
      testDb.prepare(
        `INSERT INTO strategy_feedback (strategy_id, agent_id, feedback, created_at)
         VALUES (?, 'other_agent_1', 'negative', ?)`
      ).run(stratId, Date.now());
      testDb.prepare(
        `INSERT INTO strategy_feedback (strategy_id, agent_id, feedback, created_at)
         VALUES (?, 'other_agent_2', 'negative', ?)`
      ).run(stratId, Date.now());

      // 1 revoked token audit → -10
      testDb.prepare(
        `INSERT INTO audit_log (id, action, agent_id, created_at, prev_hash, record_hash)
         VALUES ('audit_rev_1', 'revoke_token', 'agent_score_4', ?, 'GENESIS', 'hash1')`
      ).run(Date.now());

      const score = recalculateTrustScore("agent_score_4");
      // 50 - 2*2 (negative fb) - 1*10 (revoked token) = 36
      expect(score).toBeLessThanOrEqual(38);
      expect(score).toBeLessThan(50);
      // Verify the score was written back to the agents table
      const agent = testDb.prepare(`SELECT trust_score FROM agents WHERE agent_id='agent_score_4'`).get() as any;
      expect(agent.trust_score).toBe(score);
    });

    it("should clamp score to 0-100 range", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_score_5', 'Test', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      // 5 revoked tokens → -50 → clamp to 0
      for (let i = 0; i < 5; i++) {
        testDb.prepare(
          `INSERT INTO audit_log (id, action, agent_id, created_at, prev_hash, record_hash)
           VALUES (?, 'revoke_token', 'agent_score_5', ?, 'GENESIS', ?)`
        ).run(`audit_rev_5_${i}`, Date.now(), `hash_${i}`);
      }

      const score = recalculateTrustScore("agent_score_5");
      expect(score).toBe(0);
    });
  });

  describe("recalculateAllTrustScores", () => {
    it("should calculate scores for all registered agents", () => {
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_all_1', 'A1', 'member', 'offline', 50, ?)`
      ).run(Date.now());
      testDb.prepare(
        `INSERT INTO agents (agent_id, name, role, status, trust_score, created_at)
         VALUES ('agent_all_2', 'A2', 'member', 'offline', 50, ?)`
      ).run(Date.now());

      // Give agent_all_2 one verified capability
      testDb.prepare(
        `INSERT INTO agent_capabilities (id, agent_id, capability, verified, created_at)
         VALUES ('cap_all_1', 'agent_all_2', 'cap_x', 1, ?)`
      ).run(Date.now());

      const results = recalculateAllTrustScores();
      expect(results).toHaveLength(2);

      const r1 = results.find(r => r.agent_id === "agent_all_1");
      const r2 = results.find(r => r.agent_id === "agent_all_2");
      expect(r1!.score).toBe(50);
      expect(r2!.score).toBe(53); // 50 + 1*3
    });
  });
});
