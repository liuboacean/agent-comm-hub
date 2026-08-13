/**
 * authorization.test.ts — 单元测试 for src/authorization.ts
 * 覆盖：createRequest / resolve（approved+grant / rejected）/ list / sweepExpired / 信任窗口 / 自动批准
 *
 * 隔离 DB：mock db.js 指向内存库；mock sse.pushToAgent 与 security.auditLog。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let authTestDb: Database.Database;

vi.mock("../../src/db.js", () => ({
  get db() {
    return authTestDb;
  },
}));
vi.mock("../../src/sse.js", () => ({
  pushToAgent: vi.fn(() => true),
}));
vi.mock("../../src/security.js", () => ({
  auditLog: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
}));

import { authorizationService, AUTH_OP_TYPES } from "../../src/authorization.js";
import { pushToAgent } from "../../src/sse.js";
import { auditLog } from "../../src/security.js";

const mockPush = vi.mocked(pushToAgent);
const mockAudit = vi.mocked(auditLog);

beforeEach(() => {
  authTestDb = new Database(":memory:");
  authTestDb.exec(`
    CREATE TABLE IF NOT EXISTS auth_requests (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT,
      op_type TEXT NOT NULL, op_payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      resolved_by TEXT, resolved_at INTEGER, decision_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_grants (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, op_category TEXT NOT NULL,
      granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  vi.clearAllMocks();
});

describe("AuthorizationService — AUTH_OP_TYPES 常量", () => {
  it("包含设计文档规定的 8 个敏感操作类目", () => {
    expect(AUTH_OP_TYPES).toEqual([
      "delete_data",
      "cancel_task",
      "revoke_token",
      "cross_agent_delete",
      "send_external_email",
      "external_api",
      "paid_api",
      "schema_change",
    ]);
  });
});

describe("AuthorizationService — createRequest", () => {
  it("创建 pending 行并推 authorization_requested", () => {
    const req = authorizationService.createRequest("agent1", {
      type: "delete_data",
      description: "删除记忆库",
      taskId: "t1",
      payload: { key: "v" },
    });
    expect(req.status).toBe("pending");
    expect(req.agent_id).toBe("agent1");

    const row = authTestDb
      .prepare("SELECT * FROM auth_requests WHERE id=?")
      .get(req.id) as any;
    expect(row).toBeTruthy();
    expect(row.status).toBe("pending");
    expect(row.op_type).toBe("delete_data");
    expect(row.op_payload).toBe(JSON.stringify({ key: "v" }));
    expect(row.expires_at).toBeGreaterThan(row.created_at);

    expect(mockPush).toHaveBeenCalledWith(
      "agent1",
      expect.objectContaining({ event: "authorization_requested", request: expect.objectContaining({ id: req.id, status: "pending" }) })
    );
    expect(mockAudit).toHaveBeenCalledWith("auth_request", "agent1", req.id, "delete_data");
  });
});

describe("AuthorizationService — resolve", () => {
  it("approved 写入决议 + 建立信任窗口 + 推 authorization_resolved", () => {
    const req = authorizationService.createRequest("agent1", {
      type: "delete_data",
      description: "x",
      taskId: "t1",
    });
    const resolved = authorizationService.resolve(req.id, "approved", "admin", "ok", 60000);
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_by).toBe("admin");

    const row = authTestDb.prepare("SELECT * FROM auth_requests WHERE id=?").get(req.id) as any;
    expect(row.status).toBe("approved");
    expect(row.decision_reason).toBe("ok");

    const grant = authTestDb
      .prepare("SELECT * FROM auth_grants WHERE agent_id='agent1' AND op_category='delete_data'")
      .get() as any;
    expect(grant).toBeTruthy();
    expect(grant.granted_by).toBe("admin");

    expect(mockPush).toHaveBeenCalledWith(
      "agent1",
      expect.objectContaining({ event: "authorization_resolved", request_id: req.id, decision: "approved" })
    );
    expect(mockAudit).toHaveBeenCalledWith("auth_resolve", "admin", req.id, "approved|ok");
  });

  it("rejected 写入决议 + 推 authorization_resolved(rejected)", () => {
    const req = authorizationService.createRequest("agent2", { type: "revoke_token", description: "y" });
    authorizationService.resolve(req.id, "rejected", "admin", "不安全");
    const row = authTestDb.prepare("SELECT status, decision_reason FROM auth_requests WHERE id=?").get(req.id) as any;
    expect(row.status).toBe("rejected");
    expect(row.decision_reason).toBe("不安全");
    expect(mockPush).toHaveBeenCalledWith(
      "agent2",
      expect.objectContaining({ event: "authorization_resolved", decision: "rejected", reason: "不安全" })
    );
  });

  it("重复决议抛错", () => {
    const req = authorizationService.createRequest("agent3", { type: "cancel_task", description: "z" });
    authorizationService.resolve(req.id, "approved", "admin");
    expect(() => authorizationService.resolve(req.id, "approved", "admin")).toThrow(/已被决议/);
  });
});

describe("AuthorizationService — list", () => {
  it("按状态过滤", () => {
    authorizationService.createRequest("a", { type: "delete_data", description: "1" });
    const req = authorizationService.createRequest("b", { type: "cancel_task", description: "2" });
    authorizationService.resolve(req.id, "approved", "admin");

    expect(authorizationService.list("pending").length).toBe(1);
    expect(authorizationService.list("approved").length).toBe(1);
    expect(authorizationService.list().length).toBe(2);
  });
});

describe("AuthorizationService — sweepExpired", () => {
  it("过期请求标记 expired 并推 authorization_resolved(expired)", () => {
    const req = authorizationService.createRequest("agent1", { type: "delete_data", description: "x" });
    // 强制过期
    authTestDb.prepare("UPDATE auth_requests SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, req.id);

    const count = authorizationService.sweepExpired();
    expect(count).toBe(1);

    const row = authTestDb.prepare("SELECT status FROM auth_requests WHERE id=?").get(req.id) as any;
    expect(row.status).toBe("expired");
    expect(mockPush).toHaveBeenCalledWith(
      "agent1",
      expect.objectContaining({ event: "authorization_resolved", decision: "expired", request_id: req.id })
    );
    expect(mockAudit).toHaveBeenCalledWith("auth_expire", "system", req.id, "delete_data");
  });

  it("未过期请求不被清扫", () => {
    authorizationService.createRequest("agent1", { type: "delete_data", description: "fresh" });
    expect(authorizationService.sweepExpired()).toBe(0);
  });
});

describe("AuthorizationService — 信任窗口 / 自动批准", () => {
  it("hasValidGrant 判定有效窗口", () => {
    authorizationService.createGrant("agentX", "external_api", "admin", 60000);
    expect(authorizationService.hasValidGrant("agentX", "external_api")).toBe(true);
    expect(authorizationService.hasValidGrant("agentX", "delete_data")).toBe(false);
  });

  it("AUTH_AUTO_APPROVE=true 且存在有效 grant 时直接 approved", async () => {
    process.env.AUTH_AUTO_APPROVE = "true";
    vi.resetModules();
    const mod = await import("../../src/authorization.js");
    mod.authorizationService.createGrant("agentX", "external_api", "admin", 60000);
    const req = mod.authorizationService.createRequest("agentX", { type: "external_api", description: "z" });
    expect(req.status).toBe("approved");
    delete process.env.AUTH_AUTO_APPROVE;
    vi.resetModules();
  });
});
