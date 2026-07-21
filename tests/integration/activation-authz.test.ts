/**
 * activation-authz.test.ts — D8 activate/deactivate 缺对象级鉴权回归测试
 *
 * 缺陷：activateAgent / deactivateAgent 未校验操作者角色，
 *       member 可激活/挂起其他 agent。
 *
 * 目标行为（修复后）：
 *   - member 角色不能激活/挂起【其他】agent；仅 admin 或 self 可以。
 *   - admin 可激活/挂起任意 agent；self 可激活/挂起自己。
 *
 * 测试策略（同 idor.test.ts）：
 *   - makeFakeServer() 注册 tools/orchestrator 的 handler。
 *   - mock db.js（完整，含 agents / auth_tokens / audit_log）、sse、dedup、metrics、logger。
 *   - 通过 registerOrchestratorTools(server, ctx) 以不同角色 ctx 调用
 *     activate_agent / deactivate_agent，断言 member→其他 agent 被拒绝（success:false）。
 *   - security.js 保持真实（idor 已验证与 mock db 协同可用），使修复后的角色校验可走真实路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/dedup.js", () => ({
  dedupMessage: () => ({ ok: true, msgHash: "mockhash", nonce: 0 }),
  validateMessageBody: () => ({ safe: true, valid: true }),
}));

vi.mock("../../src/sse.js", () => ({
  pushToAgent: vi.fn(() => true),
  onlineAgents: vi.fn(() => []),
}));

vi.mock("../../src/metrics.js", () => ({
  incrementMcpCall: vi.fn(),
  trackHttpRequest: vi.fn(),
}));

let testDb: Database.Database;
vi.mock("../../src/db.js", () => {
  function makeMsgStmt() {
    return {
      insert: { run: (msg: any) => testDb.prepare(
        `INSERT INTO messages (id, from_agent, to_agent, content, type, metadata, status, created_at)
         VALUES (@id, @from_agent, @to_agent, @content, @type, @metadata, @status, @created_at)`
      ).run(msg) },
      markDelivered: { run: (id: string) => testDb.prepare(`UPDATE messages SET status='delivered' WHERE id=?`).run(id) },
      markRead: { run: (id: string) => testDb.prepare(`UPDATE messages SET status='read' WHERE id=?`).run(id) },
      markAcknowledged: { run: (id: string) => testDb.prepare(`UPDATE messages SET status='acknowledged' WHERE id=?`).run(id) },
      pendingFor: { all: (agentId: string) => testDb.prepare(`SELECT * FROM messages WHERE to_agent=? AND status='unread' ORDER BY created_at ASC`).all(agentId) },
      markAllDelivered: { run: (agentId: string) => testDb.prepare(`UPDATE messages SET status='delivered' WHERE to_agent=? AND status='unread'`).run(agentId) },
      getById: { get: (id: string) => testDb.prepare(`SELECT * FROM messages WHERE id=?`).get(id) },
    };
  }
  function makeTaskStmt() {
    return {
      insert: { run: (task: any) => testDb.prepare(
        `INSERT INTO tasks (id, assigned_by, assigned_to, description, context, priority, status, result, progress, pipeline_id, order_index, required_capability, due_at, assigned_at, completed_at, tags, created_at, updated_at)
         VALUES (@id, @assigned_by, @assigned_to, @description, @context, @priority, @status, @result, @progress, @pipeline_id, @order_index, @required_capability, @due_at, @assigned_at, @completed_at, @tags, @created_at, @updated_at)`
      ).run(task) },
      getById: { get: (id: string) => testDb.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) },
      update: { run: (status: string, result: string | null, progress: number, now: number, id: string) =>
        testDb.prepare(`UPDATE tasks SET status=?,result=?,progress=?,updated_at=? WHERE id=?`).run(status, result, progress, now, id) },
      updateAssignee: { run: (assignedTo: string, now1: number, now2: number, id: string) =>
        testDb.prepare(`UPDATE tasks SET assigned_to=?,assigned_at=?,status='assigned',updated_at=? WHERE id=?`).run(assignedTo, now1, now2, id) },
      listFor: { all: (agentId: string, status: string) =>
        testDb.prepare(`SELECT * FROM tasks WHERE assigned_to=? AND status=? ORDER BY created_at DESC`).all(agentId, status) },
      listByPipeline: { all: (pipelineId: string) =>
        testDb.prepare(`SELECT * FROM tasks WHERE pipeline_id=? ORDER BY order_index ASC`).all(pipelineId) },
    };
  }
  return {
    get db() { return testDb; },
    get msgStmt() { return makeMsgStmt(); },
    get taskStmt() { return makeTaskStmt(); },
    get consumedStmt() { return { insert: { run: () => {} }, check: { get: () => undefined }, listByAgent: { all: () => [] } }; },
    get attachStmt() { return { insert: { run: () => {} }, getById: { get: () => undefined }, listByMessage: { all: () => [] }, deleteById: { run: () => {} } }; },
    Attachment: {}, Task: {},
  };
});

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
  `);
  return db;
}

function seedAgent(db: Database.Database, agentId: string, role: string): void {
  db.prepare(
    `INSERT INTO agents (agent_id, name, role, status, created_at)
     VALUES (?, ?, ?, 'offline', ?)`
  ).run(agentId, agentId, role, Date.now());
}

function makeFakeServer(): any {
  const handlers: Record<string, (params: any) => any> = {};
  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (params: any) => any) => {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

import { ActivationOrchestrator } from "../../src/orchestrator.js";
import { setActivationOrchestrator, registerOrchestratorTools } from "../../src/tools/orchestrator.js";

describe("D8 activate/deactivate 对象级鉴权", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedAgent(testDb, "admin_x", "admin");
    seedAgent(testDb, "member_a", "member");
    seedAgent(testDb, "member_b", "member");
  });
  afterEach(() => {
    setActivationOrchestrator(null as any);
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  async function setupHandlers(ctx: { agentId: string; role: string }) {
    const orch = new ActivationOrchestrator();
    orch.registerAgent("member_a");
    orch.registerAgent("member_b");
    orch.registerAgent("admin_x");
    setActivationOrchestrator(orch);
    const { server, handlers } = makeFakeServer();
    registerOrchestratorTools(server, ctx as any);
    return handlers;
  }

  it("admin 激活其他 member → 成功", async () => {
    const handlers = await setupHandlers({ agentId: "admin_x", role: "admin" });
    const out = await handlers["activate_agent"]({ agent_id: "member_b" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
  });

  it("member 激活【自己】→ 成功（self 允许）", async () => {
    const handlers = await setupHandlers({ agentId: "member_a", role: "member" });
    const out = await handlers["activate_agent"]({ agent_id: "member_a" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
  });

  it("member 激活【其他】member → 拒绝（error:true，操作未执行）", async () => {
    const handlers = await setupHandlers({ agentId: "member_a", role: "member" });
    const out = await handlers["activate_agent"]({ agent_id: "member_b" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.error).toBe(true);
    expect(out.isError).toBe(true);
  });

  it("member 挂起【其他】member → 拒绝（error:true，操作未执行）", async () => {
    const handlers = await setupHandlers({ agentId: "member_a", role: "member" });
    const out = await handlers["deactivate_agent"]({ agent_id: "member_b" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.error).toBe(true);
    expect(out.isError).toBe(true);
  });

  it("member 挂起【自己】→ 成功（self 允许）", async () => {
    const handlers = await setupHandlers({ agentId: "member_a", role: "member" });
    const out = await handlers["deactivate_agent"]({ agent_id: "member_a" });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
  });
});
