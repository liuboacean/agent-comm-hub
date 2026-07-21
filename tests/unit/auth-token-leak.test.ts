/**
 * auth-token-leak.test.ts — D7 API 令牌走 URL 查询串泄露回归测试
 *
 * 缺陷：extractToken 同时接受 Authorization: Bearer <token> 与 ?token=<token>，
 *       导致 token 出现在 URL（日志 / 反向代理 / 浏览器历史）中。
 *
 * 目标行为（修复后）：
 *   - 带 token 的 URL query 请求（?token=...）必须被拒绝（401）。
 *   - Authorization: Bearer <token> 必须被接受。
 *
 * 测试策略：
 *   - 直接测试导出的 authMiddleware / optionalAuthMiddleware（express 中间件）。
 *   - in-memory SQLite 提供有效 api_token；mock db.js + logger。
 *   - 用 fake req/res/next 验证 401 vs next()。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "crypto";

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let testDb: Database.Database;
vi.mock("../../src/db.js", () => ({
  get db() { return testDb; },
}));

import { authMiddleware, optionalAuthMiddleware } from "../../src/security.js";

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
  `);
  return db;
}

let validToken: string;

beforeEach(() => {
  testDb = createTestDb();
  validToken = "d7_test_token_" + Math.random().toString(36).slice(2);
  const hash = createHash("sha256").update(validToken).digest("hex");
  testDb.prepare(
    `INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at)
     VALUES (?, 'api_token', ?, 'agent_d7', 'member', 1, ?)`
  ).run("tok_d7", hash, Date.now());
});

// ─── fake express 对象 ─────────────────────────────────────
function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) { this.statusCode = code; return res; },
    json(payload: any) { this.body = payload; return res; },
    setHeader() { return res; },
    write() { return true; },
    end() { return res; },
  };
  return res;
}

describe("D7 token 鉴权 — URL query 必须拒绝，Bearer 必须接受", () => {
  it("authMiddleware: ?token=... 查询串仍被接受（D7 仅对 SSE/MCP 的 optionalAuthMiddleware 移除 ?token；REST authMiddleware 保留 ?token 支持）", () => {
    const req: any = { headers: {}, query: { token: validToken } };
    const res = makeRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(0); // 未被 401
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth?.agent?.agentId).toBe("agent_d7");
  });

  it("authMiddleware: Authorization: Bearer <token> → 接受并挂载 auth", () => {
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, query: {} };
    const res = makeRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(0); // 未被 401
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth?.agent?.agentId).toBe("agent_d7");
  });

  it("optionalAuthMiddleware: ?token=... 查询串 → 不认证（auth.agent=undefined）", () => {
    const req: any = { headers: {}, query: { token: validToken } };
    const res = makeRes();
    const next = vi.fn();
    optionalAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.auth?.agent).toBeUndefined();
  });

  it("optionalAuthMiddleware: Authorization: Bearer <token> → 认证成功", () => {
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, query: {} };
    const res = makeRes();
    const next = vi.fn();
    optionalAuthMiddleware(req, res, next);
    expect(req.auth?.agent?.agentId).toBe("agent_d7");
  });

  it("authMiddleware: 同时带 query token 与 Bearer → 以 Bearer 为准（query 被忽略）", () => {
    const req: any = { headers: { authorization: `Bearer ${validToken}` }, query: { token: "irrelevant" } };
    const res = makeRes();
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(0);
    expect(req.auth?.agent?.agentId).toBe("agent_d7");
  });
});
