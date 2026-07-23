import { describe, it, expect, vi, beforeEach } from "vitest";

// 隔离 db：getOnlineAgentIds / isAgentOnline 的 DB 分支返回空，
// 以验证「SSE 连接本身即可判定在线」（DB 无心跳记录时仍在线）。
vi.mock("../../src/db.js", () => {
  const fakeDb = {
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  };
  return { get db() { return fakeDb; } };
});

import { registerClient, removeClient, isAgentConnected, onlineAgents } from "../../src/sse.js";
import { getOnlineAgentIds, isAgentOnline } from "../../src/identity.js";

function mockRes(): any {
  return {
    writable: true,
    writableEnded: false,
    destroyed: false,
    write: () => true,
    end: () => true,
  };
}

describe("在线状态：SSE 实时连接纳入统一判定", () => {
  beforeEach(() => {
    // 清空 clients 映射，避免用例串扰
    for (const id of onlineAgents()) removeClient(id);
  });

  it("registerClient 后 isAgentConnected 为 true", () => {
    registerClient("agent_A", mockRes());
    expect(isAgentConnected("agent_A")).toBe(true);
    expect(onlineAgents()).toContain("agent_A");
  });

  it("getOnlineAgentIds 在无心跳记录时仍包含 SSE 在线 Agent", () => {
    registerClient("agent_B", mockRes());
    // fakeDb 返回空心跳 → 仅靠 SSE 连接判定在线
    const online = getOnlineAgentIds();
    expect(online).toContain("agent_B");
  });

  it("isAgentOnline：SSE 已连即在线（即便 DB 无心跳）", () => {
    registerClient("agent_C", mockRes());
    expect(isAgentOnline("agent_C")).toBe(true);
  });

  it("removeClient 后不再在线", () => {
    registerClient("agent_D", mockRes());
    removeClient("agent_D");
    expect(isAgentConnected("agent_D")).toBe(false);
    expect(isAgentOnline("agent_D")).toBe(false);
  });

  it("未连接且无心跳记录的 Agent 判定离线", () => {
    expect(isAgentOnline("ghost_agent")).toBe(false);
  });
});
