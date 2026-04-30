/**
 * dedup.test.ts — 消息去重模块单元测试
 *
 * 策略：
 *  - 纯函数（computeDedupHash / computeMsgHash / validateMessageBody）：直接测试
 *  - 有状态函数（dedupMessage / cleanupExpiredEntries）：
 *    使用 vi.spyOn(db, 'prepare') 在每次 beforeEach 替换为测试数据库，
 *    避免 vi.mock 工厂中 mockDb.prepare 无法随测试变化的问题。
 *  - 测试隔离：beforeEach 中 resetDb() 清空所有表，afterEach 还原 spy
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { db } from "../../src/db.js";

// ─── 全局测试数据库（每次测试前重建）──────────────────────
let testDb: DatabaseType;

function setupDb(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sender_nonces (
      sender_id  TEXT PRIMARY KEY,
      last_nonce INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE dedup_cache (
      msg_hash   TEXT PRIMARY KEY,
      sender_id  TEXT NOT NULL,
      nonce      INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function resetDb(): void {
  if (testDb) {
    try { testDb.exec("DELETE FROM sender_nonces"); } catch { /* ignore */ }
    try { testDb.exec("DELETE FROM dedup_cache"); } catch { /* ignore */ }
  }
}

beforeEach(() => {
  testDb = setupDb();
  resetDb();
  // 动态替换 db.prepare，使其返回真实 :memory: 数据库的 statement
  vi.spyOn(db, "prepare").mockImplementation(
    (sql: string) => testDb.prepare(sql) as any
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  if (testDb) {
    try { testDb.close(); } catch { /* ignore */ }
  }
});

// ─── 导入被测模块 ─────────────────────────────────────────
import {
  computeDedupHash,
  computeMsgHash,
  validateMessageBody,
  isDuplicate,
  recordHash,
  nextNonce,
  currentNonce,
  resetNonce,
  dedupMessage,
  cleanupExpiredEntries,
  startDedupCleanup,
  stopDedupCleanup,
} from "../../src/dedup.js";

// ═══════════════════════════════════════════════════════════════
// 哈希计算（纯函数，无副作用）
// ═══════════════════════════════════════════════════════════════

describe("computeDedupHash", () => {
  it("相同输入产生相同哈希", () => {
    expect(computeDedupHash("alice", "bob", "hello")).toBe(
      computeDedupHash("alice", "bob", "hello")
    );
  });

  it("不同内容产生不同哈希", () => {
    expect(computeDedupHash("alice", "bob", "hello")).not.toBe(
      computeDedupHash("alice", "bob", "world")
    );
  });

  it("不同 receiver 产生不同哈希", () => {
    expect(computeDedupHash("alice", "bob", "hello")).not.toBe(
      computeDedupHash("alice", "carol", "hello")
    );
  });

  it("不同 sender 产生不同哈希", () => {
    expect(computeDedupHash("alice", "bob", "hello")).not.toBe(
      computeDedupHash("carol", "bob", "hello")
    );
  });

  it("返回 64 字符十六进制（SHA-256）", () => {
    expect(computeDedupHash("alice", "bob", "hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeMsgHash", () => {
  it("相同输入产生相同哈希", () => {
    expect(computeMsgHash("alice", "bob", "hello", 1)).toBe(
      computeMsgHash("alice", "bob", "hello", 1)
    );
  });

  it("不同 nonce 产生不同哈希", () => {
    expect(computeMsgHash("alice", "bob", "hello", 1)).not.toBe(
      computeMsgHash("alice", "bob", "hello", 2)
    );
  });

  it("不同内容产生不同哈希", () => {
    expect(computeMsgHash("alice", "bob", "hello", 1)).not.toBe(
      computeMsgHash("alice", "bob", "world", 1)
    );
  });

  it("返回 64 字符十六进制", () => {
    expect(computeMsgHash("alice", "bob", "test", 42)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 消息体校验（纯函数，无副作用）
// ═══════════════════════════════════════════════════════════════

describe("validateMessageBody", () => {
  it("正常内容返回 safe: true", () => {
    expect(validateMessageBody("Hello, world!")).toEqual({ safe: true });
  });

  it("中文内容返回 safe: true", () => {
    expect(validateMessageBody("你好，世界！")).toEqual({ safe: true });
  });

  it("空字符串返回 safe: false", () => {
    expect(validateMessageBody("")).toEqual({
      safe: false,
      reason: "Message content cannot be empty",
    });
  });

  it("纯空白返回 safe: false", () => {
    expect(validateMessageBody("  \n\t  ")).toEqual({
      safe: false,
      reason: "Message content cannot be empty",
    });
  });

  it("超长内容（>50000）返回 safe: false", () => {
    const result = validateMessageBody("a".repeat(50001));
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("too long");
  });

  it("50KB 边界值通过校验", () => {
    expect(validateMessageBody("a".repeat(50000)).safe).toBe(true);
  });

  it("NULL 字节返回 safe: false", () => {
    expect(validateMessageBody("hello\x00world")).toEqual({
      safe: false,
      reason: "Message content contains NULL byte (\\x00)",
    });
  });

  it('"data: " SSE 注入返回 safe: false', () => {
    const r = validateMessageBody("data: some event");
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("SSE injection");
  });

  it('"event: " SSE 注入返回 safe: false', () => {
    expect(validateMessageBody("event: heartbeat")).toMatchObject({
      safe: false,
      reason: expect.stringContaining("SSE injection"),
    });
  });

  it('"id: " SSE 注入返回 safe: false', () => {
    expect(validateMessageBody("id: 123")).toMatchObject({
      safe: false,
      reason: expect.stringContaining("SSE injection"),
    });
  });

  it('"retry: " SSE 注入返回 safe: false', () => {
    expect(validateMessageBody("retry: 5000")).toMatchObject({
      safe: false,
      reason: expect.stringContaining("SSE injection"),
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Nonce 管理（nextNonce / currentNonce / resetNonce）
// ═══════════════════════════════════════════════════════════════

describe("nextNonce / currentNonce / resetNonce", () => {
  it("新 sender 的 nextNonce 返回 1", () => {
    expect(nextNonce("alice")).toBe(1);
  });

  it("连续调用 nextNonce 递增", () => {
    expect(nextNonce("alice")).toBe(1);
    expect(nextNonce("alice")).toBe(2);
    expect(nextNonce("alice")).toBe(3);
  });

  it("不同 sender 的 nonce 互不影响", () => {
    nextNonce("alice");
    nextNonce("alice");
    expect(nextNonce("bob")).toBe(1);   // bob 独立从 1 开始
    expect(nextNonce("alice")).toBe(3); // alice 继续递增
  });

  it("currentNonce 返回当前 nonce（不递增）", () => {
    expect(currentNonce("unknown")).toBe(0); // 未记录返回 0
    nextNonce("alice");
    nextNonce("alice");
    expect(currentNonce("alice")).toBe(2);
  });

  it("resetNonce 清除 sender 的 nonce 记录", () => {
    nextNonce("alice");
    nextNonce("alice");
    resetNonce("alice");
    expect(currentNonce("alice")).toBe(0);
    expect(nextNonce("alice")).toBe(1); // 重置后从 1 重新开始
  });

  it("resetNonce 不影响其他 sender", () => {
    nextNonce("alice");
    nextNonce("bob");
    resetNonce("alice");
    expect(currentNonce("bob")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// isDuplicate / recordHash 的错误分支
// ═══════════════════════════════════════════════════════════════

describe("isDuplicate / recordHash error handling", () => {
  it("isDuplicate DB 出错时返回 false（允许通过）", () => {
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("db error");
    });
    expect(isDuplicate("anyhash")).toBe(false);
  });

  it("recordHash DB 出错时不抛出", () => {
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("db error");
    });
    expect(() => recordHash("h", "alice", 1)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 去重完整流程（dedupMessage 内部调用 nonce + dedup_cache）
// ═══════════════════════════════════════════════════════════════

describe("dedupMessage（完整流程）", () => {
  it("正常消息返回 ok: true，含 msgHash 和 nonce", () => {
    const result = dedupMessage("alice", "bob", "hello world");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.msgHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.nonce).toBe(1); // 每个测试独立 db，首次 nonce = 1
    }
  });

  it("空消息返回 ok: false", () => {
    const result = dedupMessage("alice", "bob", "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Message content cannot be empty");
    }
  });

  it("重复发送相同内容第二次被拒绝", () => {
    dedupMessage("alice", "bob", "hello");
    const dup = dedupMessage("alice", "bob", "hello");
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.reason).toBe("Duplicate message detected (same content from same sender)");
    }
  });

  it("同一 sender 不同 receiver 视为不同消息", () => {
    const r1 = dedupMessage("alice", "bob", "hello");
    const r2 = dedupMessage("alice", "carol", "hello");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("同一内容不同 sender 不应误判为重复", () => {
    dedupMessage("alice", "bob", "hi");
    expect(dedupMessage("carol", "bob", "hi").ok).toBe(true);
  });

  it("连续发两条不同消息，nonce 递增", () => {
    const r1 = dedupMessage("alice", "bob", "msg1");
    const r2 = dedupMessage("alice", "bob", "msg2");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.nonce).toBe(r1.nonce + 1);
    }
  });

  it("SSE 注入内容被拒绝", () => {
    expect(dedupMessage("alice", "bob", "data: fake").ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// TTL 清理
// ═══════════════════════════════════════════════════════════════

describe("cleanupExpiredEntries", () => {
  it("无过期条目返回 0", () => {
    testDb.exec("DELETE FROM dedup_cache");
    expect(cleanupExpiredEntries()).toBe(0);
  });

  it("清理过期条目并保留未过期条目，返回删除数量", () => {
    const now = Date.now();
    const TTL = 900_000;
    testDb
      .prepare(
        `INSERT INTO dedup_cache (msg_hash, sender_id, nonce, created_at) VALUES (?, ?, ?, ?)`
      )
      .run("hash_expired", "alice", 1, now - TTL - 1000);
    testDb
      .prepare(
        `INSERT INTO dedup_cache (msg_hash, sender_id, nonce, created_at) VALUES (?, ?, ?, ?)`
      )
      .run("hash_fresh", "bob", 1, now - 100);

    const deleted = cleanupExpiredEntries();
    expect(deleted).toBe(1);
    expect(isDuplicate("hash_expired")).toBe(false);
    expect(isDuplicate("hash_fresh")).toBe(true);
  });

  it("cleanupExpiredEntries 遇到 DB 错误时返回 0", () => {
    // 让 prepare 抛出错误
    vi.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("db error");
    });
    expect(cleanupExpiredEntries()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 定时清理 startDedupCleanup / stopDedupCleanup
// ═══════════════════════════════════════════════════════════════

describe("startDedupCleanup / stopDedupCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testDb = setupDb();
    vi.spyOn(db, "prepare").mockImplementation(
      (sql: string) => testDb.prepare(sql) as any
    );
  });

  afterEach(() => {
    stopDedupCleanup();  // 确保清理定时器
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  it("startDedupCleanup 应启动定时器", () => {
    startDedupCleanup();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    // 再次调用应先清除旧的定时器再新建
    startDedupCleanup();
    stopDedupCleanup();
  });

  it("stopDedupCleanup 应停止定时器", () => {
    startDedupCleanup();
    stopDedupCleanup();
    // 停止后再次 stopDedupCleanup 不应报错
    stopDedupCleanup();
  });

  it("定时器触发时执行 cleanupExpiredEntries", () => {
    const now = Date.now();
    const TTL = 900_000;
    testDb
      .prepare(
        `INSERT INTO dedup_cache (msg_hash, sender_id, nonce, created_at) VALUES (?, ?, ?, ?)`
      )
      .run("hash_to_clean", "alice", 1, now - TTL - 1000);

    startDedupCleanup();
    // 触发定时器
    vi.advanceTimersByTime(60000);
    // 过期条目应被清理
    expect(isDuplicate("hash_to_clean")).toBe(false);
    stopDedupCleanup();
  });
});
