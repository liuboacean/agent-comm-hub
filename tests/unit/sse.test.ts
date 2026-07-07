/**
 * sse.test.ts — SSE 模块单元测试
 *
 * 覆盖：registerClient / removeClient / pushToAgent / broadcast / broadcastToAll / onlineAgents
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Response } from "express";

// 不 mock logger — 直接使用实际 logger 函数（轻量，不影响测试结果）

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
    write: () => true,
    end: () => true,
  };
}

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
