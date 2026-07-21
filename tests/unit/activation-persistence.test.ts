/**
 * activation-persistence.test.ts — D2 激活态持久化回归测试
 *
 * 缺陷：activateAgent 仅维护内存 agentStates；服务端重启后，
 *       已注册但未曾激活的 agent 在 agentStates 中不存在 → activate 返回 AGENT_NOT_FOUND；
 *       已激活态若不落库，重启后丢失。
 *
 * 目标行为（修复后）：
 *   - 对已在册（agents 表存在）的 agent 调用 activate 必须成功（不返回 AGENT_NOT_FOUND）。
 *   - 重启（新建 ActivationOrchestrator + replayFromAudit）后，已激活态必须保留为 active。
 *   - 激活幂等：重复激活返回 success。
 *
 * 测试策略：
 *   - 直接测试 ActivationOrchestrator（public API 稳定）。
 *   - mock db.js（getter→testDb，含 agents + audit_log），mock security.auditLog 写入 testDb，
 *     mock sse.pushToAgent / logger。
 *   - 模拟“重启”：新建实例 + replayFromAudit()，验证状态从 audit_log 恢复。
 *
 * 前提说明：本测试假设修复采用以下任一等价实现：
 *   ① replayFromAudit()（或启动流程）从 agents 表把已注册 agent 载入 agentStates；
 *   ② activateAgent 在 agentStates 缺失时回退查 agents 表确认存在后以 registered 处理。
 *   两者都满足“在册 agent 可激活”的要求。本仓库实际实现使用独立的 seedFromDb()
 *   从 agents 表的 activation_state 列重载激活态，故“重启模拟”步骤调用 seedFromDb()。
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

// auditLog 写入 testDb，使 replayFromAudit 能从 audit_log 恢复
vi.mock("../../src/security.js", () => ({
  auditLog: vi.fn((action: string, agentId: string | null, target: string | null) => {
    if (!testDb) return;
    testDb.prepare(
      `INSERT INTO audit_log (id, action, agent_id, target, details, created_at, prev_hash, record_hash)
       VALUES (?, ?, ?, ?, '', ?, 'GENESIS', 'h')`
    ).run(`audit_${Date.now()}_${Math.random().toString(36).slice(2)}`, action, agentId, target, Date.now());
  }),
  recalculateTrustScore: vi.fn(() => 50),
}));

vi.mock("../../src/sse.js", () => ({
  pushToAgent: vi.fn(() => true),
  onlineAgents: vi.fn(() => []),
}));

import { ActivationOrchestrator } from "../../src/orchestrator.js";

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
      activation_state TEXT,
      created_at    INTEGER NOT NULL
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

function seedAgentRow(db: Database.Database, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (agent_id, name, role, status, created_at)
     VALUES (?, ?, 'member', 'offline', ?)`
  ).run(agentId, agentId, Date.now());
}

describe("D2 ActivationOrchestrator — 在册 agent 可激活 + 重启持久化", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  it("已通过 registerAgent 载入的 agent 激活返回 success（不 AGENT_NOT_FOUND）", () => {
    const orch = new ActivationOrchestrator();
    orch.registerAgent("agent_a");
    const r = orch.activateAgent("agent_a", "admin_x");
    expect(r.success).toBe(true);
    expect(r.code).not.toBe("AGENT_NOT_FOUND");
    expect(r.state).toBe("active");
  });

  it("激活幂等：重复激活返回 success", () => {
    const orch = new ActivationOrchestrator();
    orch.registerAgent("agent_a");
    orch.activateAgent("agent_a", "admin_x");
    const r = orch.activateAgent("agent_a", "admin_x");
    expect(r.success).toBe(true);
    expect(r.state).toBe("active");
  });

  it("重启模拟：新建实例 + seedFromDb 后，已激活态保留且未激活的在册 agent 仍可被激活", () => {
    // 1) 第一个“进程”：注册并激活，写 audit_log；同时在 agents 表落库一个未激活 agent
    seedAgentRow(testDb, "agent_restart"); // 在册 agent 行（含 activation_state 列），供 persist 落库 + 重启 seedFromDb 重载
    const orch1 = new ActivationOrchestrator();
    orch1.registerAgent("agent_restart");
    const first = orch1.activateAgent("agent_restart", "admin_x");
    expect(first.success).toBe(true);

    seedAgentRow(testDb, "agent_fresh"); // 在册但未曾在内存 agentStates 中

    // 2) 模拟重启：全新实例（agentStates 为空），从 agents 表 seed 激活态（D2: seedFromDb 读取 activation_state）
    const orch2 = new ActivationOrchestrator();
    orch2.seedFromDb();

    // 3) 已激活态应从 audit_log 恢复为 active
    const states = orch2.getAllAgentStates();
    const restarted = states.find((s) => s.id === "agent_restart");
    expect(restarted, "重启后 agent_restart 应保持 active").toBeDefined();
    expect(restarted!.state).toBe("active");

    // 4) 另一个“仅注册、未激活”的 agent 在 agents 表中存在，重启后仍可激活
    const fresh = orch2.activateAgent("agent_fresh", "admin_x");
    expect(fresh.success, "重启后对在册但未激活的 agent 激活应成功（不 AGENT_NOT_FOUND）").toBe(true);
    expect(fresh.code).not.toBe("AGENT_NOT_FOUND");
  });
});
