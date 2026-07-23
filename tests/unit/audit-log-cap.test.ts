import { describe, it, expect, beforeAll } from "vitest";

// 使用真实 db 模块（:memory: 隔离），验证审计日志行数上限镜像归档。
// VITEST 环境下 db.ts 严格尊重显式 DB_PATH，故动态 import 前设置 :memory: 即可隔离。
describe("enforceAuditLogCap (audit_log 行数上限镜像)", () => {
  let mod: any;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";
    process.env.VITEST = "true";
    mod = await import("../../src/db.js");
  });

  it("超阈值时镜像最旧溢出到归档（WORM：源表保留完整账本）", () => {
    const { db, enforceAuditLogCap } = mod;
    const insert = db.prepare(
      "INSERT INTO audit_log (id, action, agent_id, created_at) VALUES (?,?,?,?)"
    );
    const now = Date.now();
    for (let i = 1; i <= 5; i++) insert.run("a" + i, "act", "agent", now - i * 1000);

    const before = (db.prepare("SELECT COUNT(*) AS cnt FROM audit_log").get() as any).cnt;
    expect(before).toBe(5);

    const mirrored = enforceAuditLogCap(3);
    expect(mirrored).toBe(2);

    const remain = (db.prepare("SELECT COUNT(*) AS cnt FROM audit_log").get() as any).cnt;
    const archived = (db.prepare("SELECT COUNT(*) AS cnt FROM audit_log_archive").get() as any).cnt;
    expect(remain).toBe(5); // WORM：源表不删
    expect(archived).toBe(2);
  });

  it("未超阈值时不归档", () => {
    const { enforceAuditLogCap } = mod;
    expect(enforceAuditLogCap(10)).toBe(0);
  });

  it("已归档行幂等：重复调用不再镜像", () => {
    const { enforceAuditLogCap } = mod;
    expect(enforceAuditLogCap(3)).toBe(0);
  });
});
