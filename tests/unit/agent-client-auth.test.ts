/**
 * agent-client-auth.test.ts — 单元测试 for AgentClient.requestAuthorization
 * 覆盖：批准 / 拒绝 / 过期（决议事件 + TTL 超时）三种 Promise 解锁，以及 stop() 拒绝在途 Promise
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AgentClient,
  AuthorizationRejected,
  AuthorizationExpired,
  type SensitiveOp,
} from "../../client-sdk/agent-client.js";

const OP: SensitiveOp = { type: "delete_data", description: "清理记忆", taskId: "t1" };

describe("AgentClient.requestAuthorization", () => {
  let client: AgentClient;

  beforeEach(() => {
    client = new AgentClient({ agentId: "test-agent", hubUrl: "http://localhost:3100" });
    // 桩掉真实 MCP 调用，返回 pending + request_id
    (client as any).callTool = vi.fn(async () => ({ request_id: "req_1", status: "pending" }));
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
    delete process.env.AUTH_REQUEST_TTL_MS;
  });

  it("authorization_resolved(approved) → resolve", async () => {
    const p = client.requestAuthorization(OP);
    // requestAuthorization 是 async：内部 await callTool 完成后才登记 pendingAuth，
    // 需让出微任务使其登记完成，否则下方 routeEvent 会先于登记触发（completeAuth 幂等忽略 → p 永久 pending）。
    await Promise.resolve();
    (client as any).routeEvent({
      event: "authorization_resolved",
      request_id: "req_1",
      decision: "approved",
    });
    await expect(p).resolves.toBeUndefined();
  });

  it("authorization_resolved(rejected) → reject with AuthorizationRejected", async () => {
    const p = client.requestAuthorization(OP);
    await Promise.resolve();
    (client as any).routeEvent({
      event: "authorization_resolved",
      request_id: "req_1",
      decision: "rejected",
      reason: "不安全",
    });
    await expect(p).rejects.toBeInstanceOf(AuthorizationRejected);
    await expect(p).rejects.toMatchObject({ reason: "不安全" });
  });

  it("authorization_resolved(expired) → reject with AuthorizationExpired", async () => {
    const p = client.requestAuthorization(OP);
    await Promise.resolve();
    (client as any).routeEvent({
      event: "authorization_resolved",
      request_id: "req_1",
      decision: "expired",
    });
    await expect(p).rejects.toBeInstanceOf(AuthorizationExpired);
  });

  it("重复决议事件幂等（第二次忽略）", async () => {
    const p = client.requestAuthorization(OP);
    await Promise.resolve();
    (client as any).routeEvent({ event: "authorization_resolved", request_id: "req_1", decision: "approved" });
    // 再次推送不应导致 reject
    (client as any).routeEvent({ event: "authorization_resolved", request_id: "req_1", decision: "rejected" });
    await expect(p).resolves.toBeUndefined();
  });

  it("TTL 超时 → reject with AuthorizationExpired", async () => {
    process.env.AUTH_REQUEST_TTL_MS = "50";
    vi.useFakeTimers();
    const p = client.requestAuthorization(OP);
    await Promise.resolve();
    vi.advanceTimersByTime(80);
    await expect(p).rejects.toBeInstanceOf(AuthorizationExpired);
  });

  it("stop() 拒绝所有在途授权 Promise", async () => {
    const p = client.requestAuthorization(OP);
    await Promise.resolve();
    client.stop();
    await expect(p).rejects.toBeInstanceOf(AuthorizationExpired);
  });

  it("authorization_requested 事件透明记录（不解锁 Promise）", async () => {
    const p = client.requestAuthorization(OP);
    // 仅推 requested，Promise 应仍 pending（不 resolve/reject）
    (client as any).routeEvent({
      event: "authorization_requested",
      request: { id: "req_1", agent_id: "test-agent", op_type: "delete_data", status: "pending", created_at: 1, expires_at: 2 },
    });
    // 给微任务队列一个机会，确认没有解锁
    await new Promise((r) => setTimeout(r, 0));
    let settled = false;
    p.then(() => { settled = true; }).catch(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
  });
});
