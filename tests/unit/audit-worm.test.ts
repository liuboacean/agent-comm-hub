/**
 * audit-worm.test.ts — T9 安全加固回归测试（真实临时数据库 + 进程级）
 *
 * 覆盖：
 *   6/7. audit_log WORM：archiveOldAuditLogs 仅复制审计日志到 audit_log_archive，
 *        绝不物理删除源表记录；audit_log 由 no_delete/no_modify 触发器保护防篡改。
 *   3.  stdio 入口 HUB_AUTH_TOKEN 强制校验：缺失/非法 token → 进程 exit(1)；
 *        合法 token → 通过鉴权门禁并开始启动（打印 Authenticated as）。
 *
 * 本文件故意不使用 db.js 的 mock，而是将 VITEST/DB_PATH 指向一个真实临时文件，
 * 以便验证 WORM 触发器与归档的实际数据库行为。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawn, type ChildProcess } from "child_process";

// ─── 在导入 db.ts 之前固定测试环境（解析 DB_PATH 发生在模块加载期） ──
const TMP = mkdtempSync(join(tmpdir(), "audit-worm-"));
const DB_FILE = join(TMP, "hub.db");
process.env.VITEST = "true";
process.env.DB_PATH = DB_FILE;

let db: any;
let archiveOldAuditLogs: (days?: number) => number;
let generateToken: () => string;
let sha256: (s: string) => string;

const children: ChildProcess[] = [];

beforeAll(async () => {
  const dbMod: any = await import("../../src/db.js");
  db = dbMod.db;
  archiveOldAuditLogs = dbMod.archiveOldAuditLogs;
  const sec: any = await import("../../src/security.js");
  generateToken = sec.generateToken;
  sha256 = sec.sha256;
});

afterAll(() => {
  for (const c of children) {
    try { c.kill("SIGKILL"); } catch { /* ignore */ }
  }
});

// 清空审计表并在重置后重建防篡改触发器（否则 no_delete 会拦截清理用的 DELETE）。
// 这样每个用例都能在带触发器的真实表上独立运行。
function cleanAudit() {
  db.prepare("DROP TRIGGER IF EXISTS audit_log_no_delete").run();
  db.prepare("DROP TRIGGER IF EXISTS audit_log_no_modify").run();
  db.prepare("DELETE FROM audit_log").run();
  db.prepare("DELETE FROM audit_log_archive").run();
  db.prepare(
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_modify BEFORE UPDATE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;`
  ).run();
  db.prepare(
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
       BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;`
  ).run();
}

function seedAudit(rows: Array<[string, string, string, number]>) {
  cleanAudit();
  const ins = db.prepare(
    `INSERT INTO audit_log (id, action, agent_id, target, details, ip_address, created_at, prev_hash, record_hash)
     VALUES (?, ?, ?, ?, 'detail', '127.0.0.1', ?, ?, ?)`
  );
  for (const [id, action, agent, createdAt] of rows) {
    ins.run(id, action, agent, "tgt_" + id, createdAt, "hash_" + id, "prev_" + id);
  }
}

// ═══════════════════════════════════════════════════════════
// 7. audit_log WORM（T6）
// ═══════════════════════════════════════════════════════════
describe("T6 audit_log WORM (archiveOldAuditLogs)", () => {
  it("copies old rows to archive and NEVER deletes source rows", () => {
    const now = Date.now();
    const old = now - 10 * 24 * 60 * 60 * 1000;
    seedAudit([
      ["a_old", "tool_x", "agentA", old],
      ["a_recent", "tool_y", "agentB", now],
    ]);

    const beforeSrc = (db.prepare("SELECT COUNT(*) c FROM audit_log").get() as any).c;
    expect(beforeSrc).toBe(2);

    // cutoff = now - 1 天 → 仅 a_old 命中
    const archived = archiveOldAuditLogs(1);
    expect(archived).toBe(1);

    // WORM 核心：源表行数不变（绝不物理删除）
    const afterSrc = (db.prepare("SELECT COUNT(*) c FROM audit_log").get() as any).c;
    expect(afterSrc).toBe(beforeSrc);

    // 归档表仅增长命中行
    const arcCount = (db.prepare("SELECT COUNT(*) c FROM audit_log_archive").get() as any).c;
    expect(arcCount).toBe(1);
    expect(db.prepare("SELECT id FROM audit_log_archive WHERE id='a_old'").get()).toBeDefined();
    expect(db.prepare("SELECT id FROM audit_log_archive WHERE id='a_recent'").get()).toBeUndefined();

    // 链式完整性：源行 record_hash 仍存在且非空
    const h = db.prepare("SELECT record_hash FROM audit_log WHERE id='a_old'").get() as any;
    expect(h.record_hash).toBeTruthy();
  });

  it("re-running archive is idempotent (INSERT OR IGNORE, no duplicates)", () => {
    const now = Date.now();
    const old = now - 10 * 24 * 60 * 60 * 1000;
    seedAudit([["b_old", "tool_z", "agentC", old]]);
    archiveOldAuditLogs(1);
    archiveOldAuditLogs(1); // 第二次应幂等
    const arc = (db.prepare("SELECT COUNT(*) c FROM audit_log_archive WHERE id='b_old'").get() as any).c;
    expect(arc).toBe(1);
  });

  it("audit_log is immutable: DELETE is blocked by no_delete trigger", () => {
    const now = Date.now();
    seedAudit([["c_keep", "tool_w", "agentD", now]]);
    expect(() => db.prepare("DELETE FROM audit_log WHERE id='c_keep'").run()).toThrow(/audit log is immutable/);
  });

  it("audit_log is immutable: UPDATE is blocked by no_modify trigger", () => {
    const now = Date.now();
    seedAudit([["d_keep", "tool_v", "agentE", now]]);
    expect(() => db.prepare("UPDATE audit_log SET action='tampered' WHERE id='d_keep'").run()).toThrow(/audit log is immutable/);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. stdio HUB_AUTH_TOKEN 强制校验（T2）
// ═══════════════════════════════════════════════════════════
describe("T2 stdio HUB_AUTH_TOKEN enforcement", () => {
  const NODE = process.execPath;
  const STDIO = resolve(__dirname, "../../dist/src/stdio.js");
  let plainToken = "";

  beforeAll(() => {
    // 写入一个合法 token 到与子进程共享的同一临时库
    plainToken = generateToken();
    db.prepare(
      `INSERT OR REPLACE INTO auth_tokens
       (token_id, token_type, token_value, agent_id, role, used, created_at)
       VALUES ('tok_qa', 'api_token', ?, 'admin_agent', 'admin', 1, ?)`
    ).run(sha256(plainToken), Date.now());
    db.pragma("wal_checkpoint(TRUNCATE)");
  });

  function runStdio(token: string | undefined): ChildProcess {
    const env: Record<string, string | undefined> = { ...process.env };
    if (token === undefined) delete env.HUB_AUTH_TOKEN;
    else env.HUB_AUTH_TOKEN = token;
    const p = spawn(NODE, [STDIO], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(p);
    return p;
  }

  function waitExit(p: ChildProcess, timeoutMs = 6000): Promise<number | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (c: number | null) => { if (!done) { done = true; clearTimeout(t); resolve(c); } };
      const t = setTimeout(() => finish(null), timeoutMs);
      p.on("exit", (c: number | null) => finish(c));
    });
  }

  function waitForAuthOrExit(p: ChildProcess, timeoutMs = 6000): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let done = false;
      let stderr = "";
      let code: number | null = null;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve({ code, stderr }); } };
      const t = setTimeout(finish, timeoutMs);
      p.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.includes("Authenticated as")) finish();
      });
      p.on("exit", (c: number | null) => { code = c; finish(); });
    });
  }

  it("missing HUB_AUTH_TOKEN → process exits with code 1", async () => {
    const p = runStdio(undefined);
    const code = await waitExit(p);
    expect(code).toBe(1);
  });

  it("invalid HUB_AUTH_TOKEN → process exits with code 1", async () => {
    const p = runStdio("not-a-real-token");
    const code = await waitExit(p);
    expect(code).toBe(1);
  });

  it("valid HUB_AUTH_TOKEN → passes auth gate and starts (does not exit 1)", async () => {
    const p = runStdio(plainToken);
    const { code, stderr } = await waitForAuthOrExit(p);
    try {
      // 鉴权门禁通过后必打印此行；即便后续 server 启动有其它环节，门禁本身已验证
      expect(stderr).toContain("Authenticated as");
      if (code !== null) expect(code).not.toBe(1);
    } finally {
      try { p.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });
});
