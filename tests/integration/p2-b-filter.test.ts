/**
 * p2-b-filter.test.ts — P2-B 确定性两级过滤（L1 类型/主题 + L2 结构化条件）集成回归
 *
 * 真实 db.ts（显式 DB_PATH 隔离）+ 真实 sse.ts + 真实 subscribe_events handler。
 * 铁律：零 LLM、纯数据 DSL、无 eval、旧订阅（condition_json 为空）行为零回归。
 *
 * 覆盖：L1 零回归 / eq-ne-in-contains-gt-lt-exists / dot path / 多条件 AND /
 * 多规则 OR（唯一约束含 condition_json）/ L1∧L2 同时命中 / 非法条件 fail-closed /
 * 规范化幂等 / 精确退订 / 越权 / 与 P0 点对点通知组合零回归。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DB_FILE = path.join(os.tmpdir(), `hub-p2b-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = "test";
process.env.DB_PATH = DB_FILE;
process.env.HUB_SSE_BATCH_MS = "0";
process.env.HUB_EVENT_DRIVEN = "0"; // 本文件只测过滤，事件驱动保持关闭
delete process.env.SSE_BRIDGE_URL;

const dbMod = await import("../../src/db.js");
const sse = await import("../../src/sse.js");
const subTools = await import("../../src/tools/subscription.js");
const ed = await import("../../src/event-driven.js");
const { eventLogRepo } = await import("../../src/repo/event-log.js");

const db = dbMod.db;

// ─── 夹具 ──────────────────────────────────────────────────
function makeFakeServer(): { server: any; handlers: Record<string, (p: any) => any> } {
  const handlers: Record<string, (p: any) => any> = {};
  const server: any = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (p: any) => any) => {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

function subHandler(agentId: string): (p: any) => any {
  const { server, handlers } = makeFakeServer();
  subTools.registerSubscriptionTools(server, { agentId, role: "member" } as any);
  return handlers["subscribe_events"];
}

async function callTool(agentId: string, params: any): Promise<any> {
  const ret = await subHandler(agentId)(params);
  return JSON.parse(ret.content[0].text);
}

function createMockRes(): any {
  const writes: string[] = [];
  return {
    writes,
    writable: true,
    writableEnded: false,
    destroyed: false,
    write: (chunk: string) => { writes.push(chunk); return true; },
    end: () => true,
    setHeader: () => true,
    flushHeaders: () => true,
  };
}

function dataEvents(res: any): any[] {
  return res.writes
    .filter((w: string) => w.startsWith("data:"))
    .map((w: string) => JSON.parse(w.replace(/^data:\s*/, "").trim()));
}

/** 典型事件：带嵌套 task 与标量字段，供 L2 求值 */
function taskEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "task_assigned",
    priority: "normal",
    task: { priority: "high", status: "assigned", tags: ["urgent", "night"], score: 9 },
    ...overrides,
  };
}

beforeEach(() => {
  db.prepare("DELETE FROM subscriptions").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM event_log").run();
  for (const id of sse.onlineAgents()) sse.removeClient(id);
  sse.reloadSubsCache();
  ed.stopEventDrivenScheduler();
  process.env.HUB_EVENT_DRIVEN = "0";
  process.env.HUB_SSE_BATCH_MS = "0";
});

afterAll(() => {
  ed.stopEventDrivenScheduler();
  try { db.close(); } catch { /* ignore */ }
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

// ═══════════════════════════════════════════════════════════
// 1. L1 零回归
// ═══════════════════════════════════════════════════════════
describe("P2-B L1 零回归（condition_json 为空 = 纯 P1 语义）", () => {
  it("未订阅 Agent 全投；旧订阅命中投、未命中剪枝且不落 event_log", async () => {
    const rSub = createMockRes();
    const rPlain = createMockRes();
    sse.registerClient("l2-sub", rSub);
    sse.registerClient("l2-plain", rPlain);
    const ret = await callTool("l2-sub", { action: "subscribe", event_type: "task_assigned" });
    expect(ret.ok).toBe(true);
    expect(ret.subscriptions[0].condition_json).toBe("");

    const hit = sse.broadcastToAll(taskEvent());
    expect(hit["l2-plain"]).toBe(true);
    expect(hit["l2-sub"]).toBe(true);
    expect(dataEvents(rPlain)).toHaveLength(1);
    expect(dataEvents(rSub)).toHaveLength(1);

    const miss = sse.broadcastToAll({ event: "message", content: "hi" });
    expect(miss["l2-sub"]).toBe(false);
    expect(dataEvents(rSub)).toHaveLength(1);
    expect(eventLogRepo.getEventsAfter(0, "l2-sub")).toHaveLength(1);
  });

  it("显式空 condition_json 与不传等价，且重复订阅幂等（规范化）", async () => {
    await callTool("l2-idem", { action: "subscribe", event_type: "message", condition_json: "  " });
    await callTool("l2-idem", { action: "subscribe", event_type: "message" });
    const subs = dbMod.getSubscriptions("l2-idem");
    expect(subs).toHaveLength(1);
    expect(subs[0].condition_json).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. L2 条件求值（真实广播剪枝）
// ═══════════════════════════════════════════════════════════
describe("P2-B L2 结构化条件求值", () => {
  async function subscribeWith(agentId: string, conditions: unknown): Promise<void> {
    const ret = await callTool(agentId, {
      action: "subscribe", event_type: "task_assigned",
      condition_json: JSON.stringify(conditions),
    });
    expect(ret.error).toBeUndefined();
    expect(ret.ok).toBe(true);
  }

  it("eq：深层字段命中才投递，不命中剪枝", async () => {
    const res = createMockRes();
    sse.registerClient("op-eq", res);
    await subscribeWith("op-eq", [{ path: "task.priority", op: "eq", value: "high" }]);

    expect(sse.broadcastToAll(taskEvent())["op-eq"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { priority: "low" } }))["op-eq"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(1);
  });

  it("in / contains（字符串与数组）/ exists", async () => {
    const res = createMockRes();
    sse.registerClient("op-mix", res);
    await subscribeWith("op-mix", [
      { path: "task.status", op: "in", value: ["assigned", "in_progress"] },
      { path: "task.tags", op: "contains", value: "urgent" },
      { path: "task.score", op: "exists" },
    ]);

    expect(sse.broadcastToAll(taskEvent())["op-mix"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { status: "done", tags: [], score: 9 } }))["op-mix"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(1);
  });

  it("gt / lt / ne（数值与不等式，非数值 fail-closed）", async () => {
    const res = createMockRes();
    sse.registerClient("op-num", res);
    await subscribeWith("op-num", [
      { path: "task.score", op: "gt", value: 5 },
      { path: "task.score", op: "lt", value: 10 },
      { path: "priority", op: "ne", value: "low" },
    ]);

    expect(sse.broadcastToAll(taskEvent())["op-num"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { score: "9", tags: [], priority: "high" } }))["op-num"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(1);
  });

  it("多条件 AND：全部满足才投，任一不满足即剪枝", async () => {
    const res = createMockRes();
    sse.registerClient("op-and", res);
    await subscribeWith("op-and", [
      { path: "task.priority", op: "eq", value: "high" },
      { path: "task.score", op: "gt", value: 8 },
    ]);
    expect(sse.broadcastToAll(taskEvent())["op-and"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { priority: "high", score: 3 } }))["op-and"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(1);
  });

  it("多规则 OR：同一 L1 下不同 L2 条件可并存（唯一约束含 condition_json）", async () => {
    const res = createMockRes();
    sse.registerClient("op-or", res);
    await subscribeWith("op-or", [{ path: "task.priority", op: "eq", value: "high" }]);
    await subscribeWith("op-or", [{ path: "task.priority", op: "eq", value: "critical" }]);
    expect(dbMod.getSubscriptions("op-or")).toHaveLength(2);

    expect(sse.broadcastToAll(taskEvent())["op-or"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { priority: "critical" } }))["op-or"]).toBe(true);
    expect(sse.broadcastToAll(taskEvent({ task: { priority: "low" } }))["op-or"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(2);
  });

  it("L1 ∧ L2 必须同时命中：L1 不匹配时 L2 再匹配也剪枝", async () => {
    const res = createMockRes();
    sse.registerClient("op-both", res);
    await callTool("op-both", {
      action: "subscribe", event_type: "message", topic_filter: "URGENT",
      condition_json: JSON.stringify([{ path: "task.priority", op: "eq", value: "high" }]),
    });

    // L1 事件类型不匹配
    expect(sse.broadcastToAll(taskEvent())["op-both"]).toBe(false);
    // L1 类型匹配但 topic 子串缺失
    expect(sse.broadcastToAll({ event: "message", task: { priority: "high" } })["op-both"]).toBe(false);
    // 两级都命中
    expect(sse.broadcastToAll({ event: "message", content: "URGENT", task: { priority: "high" } })["op-both"]).toBe(true);
    expect(dataEvents(res)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 校验（fail-closed）与规范化
// ═══════════════════════════════════════════════════════════
describe("P2-B 条件校验与规范化", () => {
  const invalid: Array<[string, string]> = [
    ["非 JSON", "not-json"],
    ["非数组", '{"path":"a","op":"eq","value":1}'],
    ["非法 op", '[{"path":"a","op":"regex","value":"x"}]'],
    ["缺 value", '[{"path":"a","op":"eq"}]'],
    ["value 非标量", '[{"path":"a","op":"eq","value":{"x":1}}]'],
    ["in 的 value 非数组", '[{"path":"a","op":"in","value":"x"}]'],
    ["原型污染路径", '[{"path":"__proto__.polluted","op":"exists"}]'],
    ["非法路径字符", '[{"path":"a.b$c","op":"exists"}]'],
    ["条件数量超限", JSON.stringify(Array.from({ length: 11 }, () => ({ path: "a", op: "exists" })))],
  ];

  it.each(invalid)("非法条件被拒且不落库：%s", async (_label, raw) => {
    const ret = await callTool("invalid-agent", {
      action: "subscribe", event_type: "message", condition_json: raw,
    });
    expect(ret.error).toBe(true);
    expect(ret.message).toBeTruthy();
    expect(dbMod.getSubscriptions("invalid-agent")).toHaveLength(0);
  });

  it("规范化幂等：等价条件（键序/空白不同）只落一条规则", async () => {
    await callTool("norm-agent", {
      action: "subscribe", event_type: "message",
      condition_json: '[ { "value" : "high" , "op" : "eq" , "path" : "task.priority" } ]',
    });
    await callTool("norm-agent", {
      action: "subscribe", event_type: "message",
      condition_json: '[{"path":"task.priority","op":"eq","value":"high"}]',
    });
    expect(dbMod.getSubscriptions("norm-agent")).toHaveLength(1);
    expect(dbMod.getSubscriptions("norm-agent")[0].condition_json)
      .toBe('[{"path":"task.priority","op":"eq","value":"high"}]');
  });

  it("越权防护不变 + list 返回 condition_json", async () => {
    const ret = await callTool("real-owner", {
      action: "subscribe", event_type: "message", agent_id: "victim",
      condition_json: '[{"path":"a","op":"exists"}]',
    });
    expect(ret.agent_id).toBe("real-owner");
    expect(dbMod.getSubscriptions("victim")).toHaveLength(0);
    const list = await callTool("real-owner", { action: "list" });
    expect(list.count).toBe(1);
    expect(list.subscriptions[0].condition_json).toBe('[{"path":"a","op":"exists"}]');
  });

  it("精确退订：带 condition_json 只删单条；默认参数清空全部", async () => {
    const condA = '[{"path":"a","op":"eq","value":1}]';
    const condB = '[{"path":"b","op":"exists"}]';
    await callTool("unsub-agent", { action: "subscribe", event_type: "message", condition_json: condA });
    await callTool("unsub-agent", { action: "subscribe", event_type: "message", condition_json: condB });
    expect(dbMod.getSubscriptions("unsub-agent")).toHaveLength(2);

    const removed = await callTool("unsub-agent", {
      action: "unsubscribe", event_type: "message", condition_json: condA,
    });
    expect(removed.removed).toBe(1);
    expect(dbMod.getSubscriptions("unsub-agent")).toHaveLength(1);

    const cleared = await callTool("unsub-agent", { action: "unsubscribe" });
    expect(cleared.removed).toBe(1);
    expect(dbMod.getSubscriptions("unsub-agent")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 组合零回归：L2 不触碰点对点通知
// ═══════════════════════════════════════════════════════════
describe("P2-B 组合零回归", () => {
  it("创建者带不匹配 L2 订阅，P0 点对点 task_released 通知仍投递", async () => {
    const { releaseTasksForOfflineAgent } = await import("../../src/orchestrator.js");
    const res = createMockRes();
    sse.registerClient("creator-A", res);
    await callTool("creator-A", {
      action: "subscribe", event_type: "chat_only",
      condition_json: '[{"path":"never","op":"eq","value":1}]',
    });

    // 广播确实被两级剪枝
    expect(sse.broadcastToAll({ event: "task_released" })["creator-A"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(0);

    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, assigned_by, assigned_to, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'assigned', ?, ?)`
    ).run("p2b-combo-task", "creator-A", "worker-B", "组合测试", now, now);

    expect(releaseTasksForOfflineAgent("worker-B")).toBe(1);
    const events = dataEvents(res);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("task_released");
    expect(events[0].task_id).toBe("p2b-combo-task");
  });
});
