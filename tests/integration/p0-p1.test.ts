/**
 * p0-p1.test.ts — P0 运行时 Watchdog + P1 订阅直通/批处理 集成回归
 *
 * 与 unit 测试的区别：本文件【不 mock db.js / sse.js / orchestrator.js】，
 * 使用真实持久化层（显式 DB_PATH 隔离）+ 真实 SSE 分发 + 真实 MCP handler，
 * 验证跨模块链路，而不是重复纯函数单测。
 *
 * 覆盖链路：
 *   P1: subscribe_events handler → subscriptions 表 → reloadSubsCache → broadcastToAll 剪枝
 *       → pushToAgent 真实写入 event_log / SSE 响应（未订阅维持全投，零回归）
 *   P0: 真实 tasks 表 → releaseTasksForOfflineAgent / runWatchdogScan → 状态回收
 *       → audit_log（WORM 哈希链）→ 创建者 SSE 通知
 *   组合: 订阅剪枝不触碰点对点通知；批处理默认关闭（同步 delivered=1）不被 P0 破坏
 *
 * 隔离：vitest NODE_ENV=test 时 db.ts 严格遵循显式 DB_PATH（不回退到真实库）；
 * 用顶层 env 设置 + 动态 import 保证 db.ts 在 env 生效后才加载。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import os from "os";
import path from "path";

// 降噪：真实 db.ts 初始化会打大量 db_migration / 触发器日志
vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── 必须在任何 src 模块加载前设置（顶层 await + 动态 import） ───
const DB_FILE = path.join(os.tmpdir(), `hub-p0p1-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = "test";
process.env.DB_PATH = DB_FILE;
process.env.HUB_SSE_BATCH_MS = "0";   // 用户拍板：批处理默认关闭，锁定 D1 同步契约
delete process.env.HUB_SSE_BATCH_MAX;
delete process.env.SSE_BRIDGE_URL;    // 确保走本地 SSE 投递，不走 HTTP 桥接

const dbMod = await import("../../src/db.js");
const sse = await import("../../src/sse.js");
const subTools = await import("../../src/tools/subscription.js");
const orch = await import("../../src/orchestrator.js");
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

function makeAuth(agentId: string, role: "admin" | "member" = "member"): any {
  return { agentId, role };
}

/** 提取某次订阅工具返回的 JSON（handler 为 async，返回 Promise） */
async function toolJson(ret: any): Promise<any> {
  const r = await ret;
  return JSON.parse(r.content[0].text);
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

/** 从 SSE 写入里解析所有 data: 行的 JSON */
function dataEvents(res: any): any[] {
  return res.writes
    .filter((w: string) => w.startsWith("data:"))
    .map((w: string) => JSON.parse(w.replace(/^data:\s*/, "").trim()));
}

let taskSeq = 0;
function insertTask(overrides: Record<string, unknown> = {}): any {
  const now = Date.now();
  taskSeq += 1;
  const t: Record<string, unknown> = {
    id: `p0p1_task_${now}_${taskSeq}`,
    assigned_by: "creator-A",
    assigned_to: "worker-B",
    description: `集成测试任务 ${taskSeq}`,
    status: "assigned",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, assigned_by, assigned_to, description, status, due_at, created_at, updated_at)
     VALUES (@id, @assigned_by, @assigned_to, @description, @status, @due_at, @created_at, @updated_at)`
  ).run({ due_at: null, ...t });
  return t;
}

function taskById(id: string): any {
  return db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
}

function auditCount(action: string, target: string): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action=? AND target=?")
    .get(action, target) as { c: number };
  return row.c;
}

/** 注册订阅工具（每次用独立 fake server，避免 handler 串扰） */
function subHandler(auth: any): (p: any) => any {
  const { server, handlers } = makeFakeServer();
  subTools.registerSubscriptionTools(server, auth);
  return handlers["subscribe_events"];
}

beforeEach(() => {
  // audit_log 有 WORM 写保护触发器（禁止 UPDATE/DELETE），不清空；用 target 精确计数断言
  db.prepare("DELETE FROM subscriptions").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM event_log").run();
  for (const id of sse.onlineAgents()) sse.removeClient(id);
  sse.reloadSubsCache();
  process.env.HUB_SSE_BATCH_MS = "0";
  delete process.env.HUB_SSE_BATCH_MAX;
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

// ═══════════════════════════════════════════════════════════
// 1. P1 订阅直通：handler → DB → 缓存 → 广播剪枝 → 真实 SSE 写入
// ═══════════════════════════════════════════════════════════
describe("P1 订阅直通端到端（真实 db + handler + SSE）", () => {
  it("subscribe handler 落库并热刷新缓存；命中订阅的广播真实投递", async () => {
    const res = createMockRes();
    sse.registerClient("sub-A", res);

    const ret = await toolJson(subHandler(makeAuth("sub-A"))({ action: "subscribe", event_type: "message" }));
    expect(ret.ok).toBe(true);
    expect(ret.agent_id).toBe("sub-A");
    expect(ret.subscriptions).toHaveLength(1);
    expect(ret.subscriptions[0].event_type).toBe("message");
    expect(dbMod.getSubscriptions("sub-A")).toHaveLength(1);

    const results = sse.broadcastToAll({ event: "message", content: "hello" });
    expect(results["sub-A"]).toBe(true);
    expect(dataEvents(res)).toHaveLength(1);
    expect(dataEvents(res)[0].content).toBe("hello");
    expect(eventLogRepo.getEventsAfter(0, "sub-A")[0].delivered).toBe(1);
  });

  it("未订阅 Agent 维持全投；已订阅且规则未命中的 Agent 被剪枝（且不落 event_log）", async () => {
    const rSubscribed = createMockRes();
    const rPlain = createMockRes();
    sse.registerClient("sub-only-tasks", rSubscribed);
    sse.registerClient("plain-agent", rPlain);
    await subHandler(makeAuth("sub-only-tasks"))({ action: "subscribe", event_type: "task_assigned" });

    const results = sse.broadcastToAll({ event: "message", content: "broadcast" });

    expect(results["plain-agent"]).toBe(true);          // 未订阅 → 全投（零回归）
    expect(dataEvents(rPlain)).toHaveLength(1);
    expect(results["sub-only-tasks"]).toBe(false);      // 订阅未命中 → 剪枝
    expect(dataEvents(rSubscribed)).toHaveLength(0);
    expect(eventLogRepo.getEventsAfter(0, "sub-only-tasks")).toHaveLength(0);
  });

  it("topic_filter 子串匹配生效（payload JSON 命中/不命中）", async () => {
    const res = createMockRes();
    sse.registerClient("sub-topic", res);
    await subHandler(makeAuth("sub-topic"))({
      action: "subscribe", event_type: "*", topic_filter: "URGENT",
    });

    const miss = sse.broadcastToAll({ event: "message", content: "routine" });
    expect(miss["sub-topic"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(0);

    const hit = sse.broadcastToAll({ event: "task_assigned", content: "URGENT: ship it" });
    expect(hit["sub-topic"]).toBe(true);
    expect(dataEvents(res)).toHaveLength(1);
  });

  it("缓存必须热刷新：仅写 DB 不 reload 时广播仍全投，reload 后剪枝生效", () => {
    const res = createMockRes();
    sse.registerClient("sub-stale", res);
    dbMod.subscribeEvent("sub-stale", "task_assigned", "");

    // 未 reload：缓存里没有该 Agent → 维持全投
    expect(sse.broadcastToAll({ event: "message" })["sub-stale"]).toBe(true);
    expect(dataEvents(res)).toHaveLength(1);

    sse.reloadSubsCache();
    expect(sse.broadcastToAll({ event: "message" })["sub-stale"]).toBe(false);
    expect(dataEvents(res)).toHaveLength(1); // 无新增写入
  });

  it("重复订阅幂等；精确退订与默认清空均热刷新缓存、恢复全投", async () => {
    const h = subHandler(makeAuth("sub-unsub"));
    await h({ action: "subscribe", event_type: "message" });
    await h({ action: "subscribe", event_type: "message" });
    expect(dbMod.getSubscriptions("sub-unsub")).toHaveLength(1);

    const removed = await toolJson(h({ action: "unsubscribe", event_type: "message" }));
    expect(removed.removed).toBe(1);
    expect(dbMod.getSubscriptions("sub-unsub")).toHaveLength(0);

    const res = createMockRes();
    sse.registerClient("sub-unsub", res);
    // 清空订阅后广播恢复全投
    expect(sse.broadcastToAll({ event: "message" })["sub-unsub"]).toBe(true);

    await h({ action: "subscribe", event_type: "message" });
    await h({ action: "subscribe", event_type: "task_assigned" });
    const cleared = await toolJson(h({ action: "unsubscribe" })); // 默认参数 → 清空全部
    expect(cleared.removed).toBe(2);
    expect(dbMod.getSubscriptions("sub-unsub")).toHaveLength(0);
  });

  it("越权防护：handler 强制使用 ctx.agentId，传入的 agent_id 参数无效", async () => {
    const h = subHandler(makeAuth("real-owner"));
    const ret = await toolJson(h({ action: "subscribe", event_type: "message", agent_id: "victim" }));
    expect(ret.agent_id).toBe("real-owner");
    expect(dbMod.getSubscriptions("victim")).toHaveLength(0);
    expect(dbMod.getSubscriptions("real-owner")).toHaveLength(1);
  });

  it("权限：无认证上下文拒绝执行；member 已登记可用（fail-closed 矩阵）", async () => {
    const anon = makeFakeServer();
    subTools.registerSubscriptionTools(anon.server, undefined);
    expect(() => anon.handlers["subscribe_events"]({ action: "list" })).toThrow(/Authentication required/);

    const member = await toolJson(subHandler(makeAuth("member-agent", "member"))({ action: "list" }));
    expect(member.ok).toBe(true);
    expect(member.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. P0 Watchdog：真实 tasks 表 → 释放 → 审计 + SSE 通知
// ═══════════════════════════════════════════════════════════
describe("P0 Watchdog 端到端（真实 tasks + 审计 + 通知）", () => {
  it("离线释放：仅回收 assigned/in_progress，终态任务不动；状态 inbox + 承接人清空", () => {
    const t1 = insertTask({ assigned_to: "worker-B", status: "assigned" });
    const t2 = insertTask({ assigned_to: "worker-B", status: "in_progress" });
    const t3 = insertTask({ assigned_to: "worker-B", status: "completed" });
    const t4 = insertTask({ assigned_to: "worker-C", status: "assigned" });

    const released = orch.releaseTasksForOfflineAgent("worker-B");
    expect(released).toBe(2);

    for (const t of [t1, t2]) {
      const row = taskById(t.id);
      expect(row.status).toBe("inbox");
      expect(row.assigned_to).toBe("");
      expect(row.assigned_at).toBeNull();
    }
    expect(taskById(t3.id).status).toBe("completed");   // 终态不动
    expect(taskById(t4.id).status).toBe("assigned");    // 别人的任务不动
  });

  it("离线释放写 WORM 审计（task_released_offline 按 target 精确）", () => {
    const t = insertTask({ assigned_to: "worker-B", status: "assigned" });
    expect(auditCount("task_released_offline", t.id)).toBe(0);

    orch.releaseTasksForOfflineAgent("worker-B");

    expect(auditCount("task_released_offline", t.id)).toBe(1);
    const row = db.prepare("SELECT details FROM audit_log WHERE action=? AND target=?")
      .get("task_released_offline", t.id) as { details: string };
    expect(row.details).toContain("offline_agent=worker-B");
    expect(row.details).toContain("prev_status=assigned");
  });

  it("离线释放向在线创建者推送 task_released（真实 SSE 写入，不通知离线者自身）", () => {
    const creatorRes = createMockRes();
    sse.registerClient("creator-A", creatorRes);
    const t = insertTask({ assigned_by: "creator-A", assigned_to: "worker-B", status: "assigned" });

    orch.releaseTasksForOfflineAgent("worker-B");

    const events = dataEvents(creatorRes);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("task_released");
    expect(events[0].task_id).toBe(t.id);
    expect(events[0].reason).toBe("assigned_agent_offline");
    // 离线 Agent 自身不应收到任何推送（事件仍可能落库供补发，但 delivered=0）
    const offline = eventLogRepo.getEventsAfter(0, "worker-B");
    expect(offline).toHaveLength(0);
  });

  it("幂等：二次离线释放返回 0，不重复写审计/通知", () => {
    const creatorRes = createMockRes();
    sse.registerClient("creator-A", creatorRes);
    const t = insertTask({ assigned_by: "creator-A", assigned_to: "worker-B", status: "assigned" });

    expect(orch.releaseTasksForOfflineAgent("worker-B")).toBe(1);
    expect(orch.releaseTasksForOfflineAgent("worker-B")).toBe(0);

    expect(auditCount("task_released_offline", t.id)).toBe(1);
    expect(dataEvents(creatorRes)).toHaveLength(1);
  });

  it("卡死巡检：超阈值任务被释放并写审计，新任务不动；scanned/released 计数正确", () => {
    const now = Date.now();
    process.env.WATCHDOG_STUCK_MS = String(30 * 60 * 1000); // 30 分钟
    const old = insertTask({ status: "in_progress", updated_at: now - 31 * 60 * 1000 });
    const fresh = insertTask({ status: "assigned", updated_at: now });

    const result = orch.runWatchdogScan();
    expect(result.released).toBe(1);
    expect(result.scanned).toBe(1);
    expect(taskById(old.id).status).toBe("inbox");
    expect(taskById(fresh.id).status).toBe("assigned");
    expect(auditCount("task_released_stuck", old.id)).toBe(1);
  });

  it("卡死巡检覆盖 due_at 过期路径（updated_at 仍是新值也应回收）", () => {
    const now = Date.now();
    process.env.WATCHDOG_STUCK_MS = String(30 * 60 * 1000);
    const overdue = insertTask({ status: "assigned", updated_at: now, due_at: now - 60_000 });

    const result = orch.runWatchdogScan();
    expect(result.released).toBe(1);
    expect(taskById(overdue.id).status).toBe("inbox");
    delete process.env.WATCHDOG_STUCK_MS;
  });
});

// ═══════════════════════════════════════════════════════════
// 3. P0 × P1 组合零回归（两个特性同时启用时互不干扰）
// ═══════════════════════════════════════════════════════════
describe("P0 × P1 组合零回归", () => {
  it("订阅剪枝只作用于广播：创建者订阅不匹配类型，仍收到 P0 点对点释放通知", async () => {
    const creatorRes = createMockRes();
    sse.registerClient("creator-A", creatorRes);
    // 创建一个与 task_released 完全不匹配的订阅
    await subHandler(makeAuth("creator-A"))({ action: "subscribe", event_type: "chat_only", topic_filter: "NEVER" });

    // 先证明广播确实被剪枝
    expect(sse.broadcastToAll({ event: "task_released" })["creator-A"]).toBe(false);
    expect(dataEvents(creatorRes)).toHaveLength(0);

    const t = insertTask({ assigned_by: "creator-A", assigned_to: "worker-B", status: "assigned" });
    orch.releaseTasksForOfflineAgent("worker-B");

    // 点对点通知不受剪枝影响，必须投递
    const events = dataEvents(creatorRes);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("task_released");
    expect(events[0].task_id).toBe(t.id);
  });

  it("批处理默认关闭：未显式设 HUB_SSE_BATCH_MS 时投递仍同步且 delivered=1", () => {
    delete process.env.HUB_SSE_BATCH_MS;
    try {
      const res = createMockRes();
      sse.registerClient("default-off", res);
      const t = insertTask({ assigned_by: "creator-A", assigned_to: "worker-B", status: "assigned" });

      expect(orch.releaseTasksForOfflineAgent("worker-B")).toBe(1);
      // 通知在调用返回前已落网（非 120ms 后异步冲刷）
      const events = dataEvents(res);
      expect(events).toHaveLength(0); // 通知发给 creator-A，不是 default-off
      const creatorEvents = eventLogRepo.getEventsAfter(0, "creator-A");
      expect(creatorEvents).toHaveLength(1);
      expect(creatorEvents[0].delivered).toBe(0); // creator-A 未连接 → 离线落库待补发
      const notifier = eventLogRepo.getUndelivered("creator-A");
      expect(notifier.some((e: any) => e.payload.includes(t.id))).toBe(true);

      // 在线 Agent 的直接推送：同步写 + 即时 delivered=1
      expect(sse.pushToAgent("default-off", { event: "ping" })).toBe(true);
      expect(dataEvents(res)).toHaveLength(1);
      expect(eventLogRepo.getEventsAfter(0, "default-off")[0].delivered).toBe(1);
    } finally {
      process.env.HUB_SSE_BATCH_MS = "0";
    }
  });
});
