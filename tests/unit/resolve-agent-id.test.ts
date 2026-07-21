/**
 * resolve-agent-id.test.ts — D9 消息路由回归测试
 *
 * 缺陷（已修复）：resolveAgentId 使用子串模糊匹配（agent_id.toLowerCase().includes(input)），
 *       导致发给精确 agent_id="abc" 的消息被误投到更长的 "abcd"。
 *
 * 目标行为（修复后）：
 *   - 精确全 id（如 "agent_abc"）必须解析到自身，绝不误投到 "agent_abcd"。
 *   - 仅接受精确完整 agent_id（以 agent_ 开头且库中真实存在）或显式别名。
 *   - 短片段 / 重叠 id（如 "abc"）必须返回 null，绝不以子串误匹配到更长 id（IDOR 风险）。
 *
 * 测试策略：
 *   - in-memory SQLite 隔离数据；mock db.js + logger。
 *   - resolveAgentId 为纯函数，直接调用断言。
 *   - 注意：getAgent 会查询 agent_capabilities 表，mock 必须建该表。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let testDb: Database.Database;
vi.mock("../../src/db.js", () => ({
  get db() { return testDb; },
}));

import { resolveAgentId } from "../../src/identity.js";

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
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_id  TEXT NOT NULL,
      capability TEXT NOT NULL
    );
  `);
  return db;
}

function seedAgent(db: Database.Database, agentId: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO agents (agent_id, name, role, status, created_at)
     VALUES (?, ?, 'member', 'offline', ?)`
  ).run(agentId, agentId, createdAt);
}

describe("D9 resolveAgentId — 精确 id 不得被子串误投", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  it("精确全 id 'agent_abc' 必须解析到自身（不误投 agent_abcd）", () => {
    const base = Date.now();
    seedAgent(testDb, "agent_abc", base);
    seedAgent(testDb, "agent_abcd", base + 1);
    expect(resolveAgentId("agent_abc")).toBe("agent_abc");
  });

  it("精确全 id 'agent_abcd' 必须解析到自身", () => {
    const base = Date.now();
    seedAgent(testDb, "agent_abc", base);
    seedAgent(testDb, "agent_abcd", base + 1);
    expect(resolveAgentId("agent_abcd")).toBe("agent_abcd");
  });

  it("片段 'abc' 必须返回 null（D9 修复：不再做子串模糊匹配，避免误投）", () => {
    // 设计口径：仅接受精确完整 agent_id（以 agent_ 开头且库中真实存在）或显式别名。
    // 短片段不得匹配到任何更长 id，防止消息误投（IDOR 风险）。
    const base = Date.now();
    seedAgent(testDb, "agent_abcd", base);
    seedAgent(testDb, "agent_abc", base + 1);
    const resolved = resolveAgentId("abc");
    expect(resolved).toBeNull();
    // 即便存在更长 id，片段仍不得命中（不误投 agent_abcd）
    expect(resolved).not.toBe("agent_abcd");
  });

  it("不存在的 id 返回 null", () => {
    seedAgent(testDb, "agent_xyz", Date.now());
    expect(resolveAgentId("nope")).toBeNull();
  });

  it("空/纯空白输入返回 null", () => {
    expect(resolveAgentId("")).toBeNull();
    expect(resolveAgentId("   ")).toBeNull();
  });
});
