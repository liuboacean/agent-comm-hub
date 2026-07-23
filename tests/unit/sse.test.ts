/**
 * sse.test.ts — SSE 模块单元测试
 *
 * 覆盖：registerClient / removeClient / pushToAgent / broadcast / broadcastToAll / onlineAgents
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { Response } from "express";
import Database from "better-sqlite3";

// 不 mock logger — 直接使用实际 logger 函数（轻量，不影响测试结果）

// 隔离 DB：pushToAgent 内部通过 eventLogRepo 写 event_log，
// mock db.js 指向内存库，避免污染仓库真实 comm_hub.db。
let sseTestDb: Database.Database;
vi.mock("../../src/db.js", () => ({
  get db() {
    return sseTestDb;
  },
}));

import {
  registerClient,
  removeClient,
  pushToAgent,
  broadcast,
  onlineAgents,
  connectedCount,
  drainAllClients,
} from "../../src/sse.js";

function createMockRes(): any {
  return {
    // 满足 sse.ts isWritable 检查（P2-5 修复）：可写、未结束、未销毁
    writable: true,
    writableEnded: false,
    destroyed: false,
    write: () => true,
    end: () => true,
  };
}

beforeEach(() => {
  sseTestDb = new Database(":memory:");
  sseTestDb.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
  `);
});

describe("SSE — registerClient / removeClient", () => {
  afterEach(() => {
    for (const id of onlineAgents()) {
      removeClient(id);
    }
  });

  it("should register a client", () => {
    registerClient("sse-test-1", createMockRes() as any);
    expect(onlineAgents()).toContain("sse-test-1");
    expect(connectedCount()).toBeGreaterThanOrEqual(1);
  });

  it("should replace existing connection on re-register", () => {
    const res1 = createMockRes();
    const res2 = createMockRes();
    registerClient("sse-test-2", res1 as any);
    registerClient("sse-test-2", res2 as any);
    expect(onlineAgents()).toContain("sse-test-2");
  });

  it("should remove a client", () => {
    registerClient("sse-test-3", createMockRes() as any);
    expect(onlineAgents()).toContain("sse-test-3");
    removeClient("sse-test-3");
    expect(onlineAgents()).not.toContain("sse-test-3");
  });

  // P1-1 修复：旧连接的 close 事件不得误删「当前」实时连接
  it("P1-1: stale old-socket close must NOT remove the live reconnection", () => {
    const oldRes = createMockRes();
    const newRes = createMockRes();
    const oldCid = registerClient("sse-reconn", oldRes as any);
    const newCid = registerClient("sse-reconn", newRes as any); // 重连，旧 socket 稍后被关
    expect(onlineAgents()).toContain("sse-reconn");
    // 模拟旧 socket 的 close 事件（传入旧 connId）
    removeClient("sse-reconn", oldCid);
    // 当前连接（newCid）必须仍在，实时投递不丢
    expect(onlineAgents()).toContain("sse-reconn");
    // 当前连接的 close（传入 newCid）才真正移除
    removeClient("sse-reconn", newCid);
    expect(onlineAgents()).not.toContain("sse-reconn");
  });

  // 无 connId 的 removeClient（drain / 僵尸清理）仍应移除
  it("P1-1: removeClient without connId always removes (drain/zombie)", () => {
    registerClient("sse-reconn-2", createMockRes() as any);
    removeClient("sse-reconn-2"); // 不传 connId
    expect(onlineAgents()).not.toContain("sse-reconn-2");
  });
});

describe("SSE — pushToAgent", () => {
  afterEach(() => {
    for (const id of onlineAgents()) removeClient(id);
  });

  it("should push event to online agent", () => {
    const res = createMockRes();
    registerClient("sse-push-1", res as any);
    const result = pushToAgent("sse-push-1", { type: "test" });
    expect(result).toBe(true);
  });

  it("should return false for offline agent", () => {
    const result = pushToAgent("sse-offline", { type: "test" });
    expect(result).toBe(false);
  });
});

describe("SSE — broadcast / drainAllClients", () => {
  afterEach(() => {
    for (const id of onlineAgents()) removeClient(id);
  });

  it("should broadcast to online agents", () => {
    registerClient("sse-bc-1", createMockRes() as any);
    registerClient("sse-bc-2", createMockRes() as any);
    registerClient("sse-bc-3", createMockRes() as any);
    const results = broadcast(["sse-bc-1", "sse-bc-3", "sse-offline"], { type: "test" });
    expect(results["sse-bc-1"]).toBe(true);
    expect(results["sse-bc-3"]).toBe(true);
    expect(results["sse-offline"]).toBe(false);
  });

  it("should drain all clients", () => {
    registerClient("sse-dr-1", createMockRes() as any);
    registerClient("sse-dr-2", createMockRes() as any);
    expect(connectedCount()).toBeGreaterThanOrEqual(1);
    drainAllClients();
    expect(connectedCount()).toBe(0);
  });
});
