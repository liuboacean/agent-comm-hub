/**
 * sse-replay.test.ts — D1 SSE 可靠投递回归测试
 *
 * 缺陷（已修复）：
 *   1) 客户端以 Last-Event-ID=N 重连时，服务端按时间戳重放【整 1h 窗口】，
 *      而非 seq > N 的精确事件。
 *   2) 首连推送成功才标记 delivered；原实现无论推送是否成功都 markAllDelivered。
 *   3) 重放只硬编码 event:"new_message"，其它事件类型不可重放。
 *
 * 修复后行为（本文件验证）：
 *   - 每次推送先持久化到 event_log 取得【全局单调】seq，并以该 seq 作为 SSE `id` 发送。
 *   - 重放只返回 seq > Last-Event-ID 的事件（eventLogRepo.getEventsAfter），按 agent 隔离。
 *   - 所有事件类型均可重放（保留原始 event 类型）。
 *   - 仅当本次写入响应成功才标记 delivered=1；离线（无连接）时事件仍落库 delivered=0，待首连/重连补发。
 *
 * 测试策略：
 *   - 单元层锁定可稳定断言的部分：event_log 全局 seq、pushToAgent 的 id/_hub_event_id、
 *     delivered 标记时机、getEventsAfter 的精确重放边界与 agent 隔离。
 *   - HTTP 层（server.ts 解析 Last-Event-ID → getEventsAfter）由集成测试覆盖，本文件以
 *     注释标注该契约：给定持久化事件序列 [1..N]，以 Last-Event-ID=k 重连，断言仅收到 seq∈(k, N]。
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

import { eventLogRepo } from "../../src/repo/event-log.js";
import { registerClient, removeClient, pushToAgent, onlineAgents } from "../../src/sse.js";

function createMockRes(): any {
  const writes: string[] = [];
  return {
    writes,
    write: (chunk: string) => { writes.push(chunk); return true; },
    end: () => true,
    setHeader: () => true,
    flushHeaders: () => true,
  };
}

function extractEventIds(res: any): number[] {
  const ids: number[] = [];
  for (const chunk of res.writes) {
    const m = chunk.match(/^id:\s*(\d+)/m);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("D1 SSE — 全局单调 _hub_event_id（event_log seq）", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    for (const id of onlineAgents()) removeClient(id);
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  it("连续 pushToAgent 为同一连接分配全局严格递增 seq", () => {
    const res = createMockRes();
    registerClient("d1-seq-1", res as any);
    pushToAgent("d1-seq-1", { type: "a" });
    pushToAgent("d1-seq-1", { type: "b" });
    pushToAgent("d1-seq-1", { type: "c" });
    expect(extractEventIds(res)).toEqual([1, 2, 3]);
  });

  it("payload 携带 _hub_event_id 且与全局 seq 一致", () => {
    const res = createMockRes();
    registerClient("d1-seq-2", res as any);
    pushToAgent("d1-seq-2", { hello: "world" });
    const dataLine = res.writes.find((w: string) => w.startsWith("data:"));
    const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    expect(payload._hub_event_id).toBe(1);
  });

  it("不同连接共享全局 seq（各自唯一，不串号）", () => {
    const r1 = createMockRes();
    const r2 = createMockRes();
    registerClient("d1-seq-a", r1 as any);
    registerClient("d1-seq-b", r2 as any);
    pushToAgent("d1-seq-a", { t: 1 }); // seq 1
    pushToAgent("d1-seq-b", { t: 1 }); // seq 2（全局单调，非 per-connection）
    expect(extractEventIds(r1)).toEqual([1]);
    expect(extractEventIds(r2)).toEqual([2]);
  });

  it("离线推送：返回 false，事件已落库且 delivered=0（待首连/重连补发）", () => {
    // 未 registerClient → 离线
    const ok = pushToAgent("d1-offline", { type: "x" });
    expect(ok).toBe(false);
    const rows = eventLogRepo.getUndelivered("d1-offline");
    expect(rows.length).toBe(1);
    expect(rows[0].delivered).toBe(0);
  });

  it("在线推送成功后标记 delivered=1", () => {
    const res = createMockRes();
    registerClient("d1-online", res as any);
    pushToAgent("d1-online", { type: "x" });
    const all = eventLogRepo.getEventsAfter(0, "d1-online");
    expect(all.length).toBe(1);
    expect(all[0].delivered).toBe(1);
  });
});

describe("D1 SSE — 重放边界（eventLogRepo.getEventsAfter 仅返回 seq 之后）", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => {
    if (testDb) { try { testDb.close(); } catch { /* ignore */ } }
  });

  it("getEventsAfter 只返回 id > seq 的事件（不重放整窗口）", () => {
    eventLogRepo.appendEvent("d1-sub", "new_message", "m_old");
    const mid = eventLogRepo.appendEvent("d1-sub", "new_message", "m_mid");
    eventLogRepo.appendEvent("d1-sub", "new_message", "m_recent");
    const result = eventLogRepo.getEventsAfter(mid, "d1-sub");
    expect(result.map((e) => e.id)).toEqual([mid + 1]); // 仅返回 mid 之后
    expect(result.every((e) => e.id > mid)).toBe(true);
  });

  it("getEventsAfter 按 agent 隔离（仅返回该 agent 的后续事件）", () => {
    const a1 = eventLogRepo.appendEvent("d1-A", "t", "a1"); // seq 1
    eventLogRepo.appendEvent("d1-A", "t", "a2");             // seq 2（同 agent 的后续事件）
    eventLogRepo.appendEvent("d1-B", "t", "b1");             // seq 3（不同 agent，必须被排除）
    // id > a1 且 agent=d1-A → 仅 seq2，绝不包含 d1-B 的 seq3
    const result = eventLogRepo.getEventsAfter(a1, "d1-A");
    expect(result.map((e) => e.id)).toEqual([a1 + 1]);
    expect(result.every((e) => e.agent_id === "d1-A")).toBe(true);
  });
});
