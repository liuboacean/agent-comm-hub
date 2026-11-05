/**
 * p2-event-driven.test.ts — P2-A 事件驱动（outbox-lite + 到期驱动）集成回归
 *
 * 与 p0-p1.test.ts 同范式：不 mock db/sse/event-driven，使用显式 DB_PATH 隔离的
 * 真实持久化层 + 真实 SSE 分发。HUB_EVENT_DRIVEN=1 显式启用（生产默认关闭）。
 *
 * 覆盖：
 *   A1: withEvents 事务提交必达 / 回滚无幽灵事件 / 条件事件 / dispatch 幂等 /
 *       离线待发后补投 / D1 同步契约 delivered=1
 *   A2: computeNextDeadline 取 MIN(due_at, updated_at+stuckMs) / 启动重建 /
 *       到期准点事务化释放 / notifyScheduleChanged 重算 / 宽限期重连不误判 /
 *       宽限期到期释放 / stop 清空 timer / 默认关闭零回归
 *
 * 铁律：零 LLM、确定性、事件必落 event_log（至少一次）、不改变 pushToAgent 契约。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── 顶层 env + 动态 import（db.ts 必须在 env 生效后加载） ───
const DB_FILE = path.join(os.tmpdir(), `hub-p2-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = "test";
process.env.DB_PATH = DB_FILE;
process.env.HUB_EVENT_DRIVEN = "1";
process.env.HUB_EVENT_GRACE_MS = "30";       // 短宽限期，便于定时测试
process.env.WATCHDOG_STUCK_MS = String(30 * 60 * 1000);
process.env.HUB_SSE_BATCH_MS = "0";
delete process.env.SSE_BRIDGE_URL;
delete process.env.HUB_EVENT_MAX_DELAY_MS;

const dbMod = await import("../../src/db.js");
const sse = await import("../../src/sse.js");
const ed = await import("../../src/event-driven.js");
const { eventLogRepo } = await import("../../src/repo/event-log.js");

const db = dbMod.db;

// ─── 夹具 ──────────────────────────────────────────────────
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

let taskSeq = 0;
function insertTask(overrides: Record<string, unknown> = {}): any {
  const now = Date.now();
  taskSeq += 1;
  const t: Record<string, unknown> = {
    id: `p2_task_${now}_${taskSeq}`,
    assigned_by: "creator-A",
    assigned_to: "worker-B",
    description: `P2 测试任务 ${taskSeq}`,
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db.prepare("DELETE FROM subscriptions").run();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM event_log").run();
  for (const id of sse.onlineAgents()) sse.removeClient(id);
  sse.reloadSubsCache();
  ed.stopEventDrivenScheduler();
  process.env.HUB_EVENT_DRIVEN = "1";
  process.env.HUB_EVENT_GRACE_MS = "30";
  process.env.WATCHDOG_STUCK_MS = String(30 * 60 * 1000);
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
// A1: outbox-lite 事务化事件发射
// ═══════════════════════════════════════════════════════════
describe("P2-A1 事务化事件发射（同一事务落库，提交后同步投递）", () => {
  it("提交必达：业务写与事件同事务，返回前已完成投递且 delivered=1", () => {
    const res = createMockRes();
    sse.registerClient("creator-A", res);

    const result = ed.withEvents(
      () => insertTask({ status: "assigned" }),
      [{ agentId: "creator-A", event: { event: "task_assigned", msg: "go" } }]
    );

    expect(result.id).toBeTruthy();
    expect(taskById(result.id).status).toBe("assigned");
    const events = eventLogRepo.getEventsAfter(0, "creator-A");
    expect(events).toHaveLength(1);
    expect(events[0].delivered).toBe(1); // D1 同步契约：返回即已投递
    expect(dataEvents(res)).toHaveLength(1);
    expect(dataEvents(res)[0]._hub_event_id).toBe(events[0].id);
    expect(dataEvents(res)[0].msg).toBe("go");
  });

  it("事务回滚无幽灵事件：business 抛错时任务与事件一起回滚、绝不外发", () => {
    const res = createMockRes();
    sse.registerClient("creator-A", res);

    expect(() => ed.withEvents(
      () => {
        insertTask({ id: "rollback-task" });
        throw new Error("business failed");
      },
      [{ agentId: "creator-A", event: { event: "task_assigned" } }]
    )).toThrow("business failed");

    expect(taskById("rollback-task")).toBeUndefined();
    expect(eventLogRepo.getEventsAfter(0, "creator-A")).toHaveLength(0);
    expect(dataEvents(res)).toHaveLength(0);
  });

  it("条件事件：business 返回 false 时动态事件为空，不落库不投递", () => {
    const res = createMockRes();
    sse.registerClient("creator-A", res);

    const ok = ed.withEvents(
      () => false,
      (success: boolean) => success
        ? [{ agentId: "creator-A", event: { event: "task_assigned" } }]
        : []
    );

    expect(ok).toBe(false);
    expect(eventLogRepo.getEventsAfter(0, "creator-A")).toHaveLength(0);
    expect(dataEvents(res)).toHaveLength(0);
  });

  it("dispatch 幂等：同一 seq 重复投递只写一次，不重复标记", () => {
    const res = createMockRes();
    sse.registerClient("creator-A", res);
    const seq = ed.emitEvent("creator-A", { event: "ping", n: 1 });

    expect(ed.dispatchPersistedEvent(seq)).toBe(true);
    expect(ed.dispatchPersistedEvent(seq)).toBe(true); // 已 delivered，短路
    expect(dataEvents(res)).toHaveLength(1);
    expect(eventLogRepo.getEventsAfter(0, "creator-A")[0].delivered).toBe(1);
  });

  it("离线待发：无连接时事件 delivered=0，补投后写入并标记（至少一次）", () => {
    const seq = ed.emitEvent("late-agent", { event: "ping" });
    expect(eventLogRepo.getEventsAfter(0, "late-agent")[0].delivered).toBe(0);
    expect(ed.dispatchPersistedEvent(seq)).toBe(false); // 无本地连接

    const res = createMockRes();
    sse.registerClient("late-agent", res);
    expect(ed.dispatchPersistedEvent(seq)).toBe(true);
    expect(dataEvents(res)).toHaveLength(1);
    expect(eventLogRepo.getEventsAfter(0, "late-agent")[0].delivered).toBe(1);
  });

  it("withEvents 离线提交：事件留库待补发，注册连接后 replay 可覆盖", () => {
    ed.withEvents(
      () => insertTask({ status: "assigned" }),
      [{ agentId: "offline-creator", event: { event: "task_assigned" } }]
    );
    const pending = eventLogRepo.getUndelivered("offline-creator");
    expect(pending).toHaveLength(1);
    expect(pending[0].delivered).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// A2: 到期驱动调度
// ═══════════════════════════════════════════════════════════
describe("P2-A2 到期驱动（单 timer 精确触发 + 断线宽限期）", () => {
  it("computeNextDeadline 取 MIN(due_at, updated_at+stuckMs)，无任务返回 null", () => {
    expect(ed.computeNextDeadline()).toBeNull();

    const now = Date.now();
    const sm = ed.stuckThresholdMs();
    insertTask({ id: "no-due", updated_at: now - 10 * 60 * 1000 });       // now-10m + 30m
    insertTask({ id: "with-due", updated_at: now, due_at: now + 60_000 }); // +1m（更早）
    insertTask({ id: "terminal", status: "completed", updated_at: now - sm * 2 }); // 终态不计入

    const expected = now + 60_000;
    const got = ed.computeNextDeadline();
    expect(got).not.toBeNull();
    expect(Math.abs(got! - expected)).toBeLessThan(2000); // 允许毫秒级时间推进
  });

  it("启动重建：DB 中已有过期任务时，start 即按到期时间触发事务化释放", async () => {
    const now = Date.now();
    insertTask({ id: "overdue-1", status: "in_progress", updated_at: now, due_at: now - 60_000 });

    ed.startEventDrivenScheduler({ onDeadline: ed.runEventDrivenScan });
    await wait(80);

    expect(taskById("overdue-1").status).toBe("inbox");
    expect(taskById("overdue-1").assigned_to).toBe("");
    expect(auditCount("task_released_stuck", "overdue-1")).toBe(1);
    // 通知事件与释放同事务落库（创建者未连接 → 留 delivered=0 待补发）
    const pending = eventLogRepo.getUndelivered("creator-A");
    expect(pending.some((e: any) => e.payload.includes("overdue-1"))).toBe(true);
  });

  it("到期扫描幂等且不误伤：终态/未到期任务不动，重复扫描 released=0", async () => {
    const now = Date.now();
    insertTask({ id: "fresh", status: "assigned", updated_at: now });
    insertTask({ id: "done", status: "completed", updated_at: now - 60 * 60 * 1000 });

    const first = ed.runEventDrivenScan();
    expect(first.released).toBe(0);
    expect(taskById("fresh").status).toBe("assigned");
    expect(taskById("done").status).toBe("completed");

    insertTask({ id: "stale", status: "assigned", updated_at: now, due_at: now - 1000 });
    expect(ed.runEventDrivenScan().released).toBe(1);
    expect(ed.runEventDrivenScan().released).toBe(0); // 幂等
    expect(taskById("stale").status).toBe("inbox");
  });

  it("notifyScheduleChanged 重算到期：启动后新增更早任务仍能准点触发", async () => {
    ed.startEventDrivenScheduler({ onDeadline: ed.runEventDrivenScan });
    const now = Date.now();
    insertTask({ id: "late-added", status: "assigned", updated_at: now, due_at: now + 20 });

    ed.notifyScheduleChanged();
    await wait(90);

    expect(taskById("late-added").status).toBe("inbox");
  });

  it("宽限期重连不误判：断线后立即重连，到期也不触发释放", async () => {
    const spy = vi.fn();
    ed.startEventDrivenScheduler({
      onDeadline: () => ({ scanned: 0, released: 0 }),
      onGraceExpired: spy,
    });
    insertTask({ assigned_to: "grace-agent", status: "assigned" });

    ed.onClientDisconnected("grace-agent");
    ed.onClientConnected("grace-agent"); // 重连取消宽限期
    await wait(90);

    expect(spy).not.toHaveBeenCalled();
  });

  it("宽限期到期释放孤儿任务（幂等，不重复通知）", async () => {
    const { releaseTasksForOfflineAgent } = await import("../../src/orchestrator.js");
    ed.startEventDrivenScheduler({
      onDeadline: () => ({ scanned: 0, released: 0 }),
      onGraceExpired: releaseTasksForOfflineAgent,
    });
    const t = insertTask({ assigned_to: "gone-agent", status: "assigned" });

    ed.onClientDisconnected("gone-agent");
    await wait(90);

    expect(taskById(t.id).status).toBe("inbox");
    expect(taskById(t.id).assigned_to).toBe("");
    expect(auditCount("task_released_offline", t.id)).toBe(1);
  });

  it("stop 清空全部 timer：停止后断线不再启动宽限期", async () => {
    const spy = vi.fn();
    ed.startEventDrivenScheduler({
      onDeadline: () => ({ scanned: 0, released: 0 }),
      onGraceExpired: spy,
    });
    ed.stopEventDrivenScheduler();

    ed.onClientDisconnected("after-stop");
    await wait(90);
    expect(spy).not.toHaveBeenCalled();
  });

  it("默认关闭零回归：HUB_EVENT_DRIVEN=0 时所有挂钩为 no-op", async () => {
    process.env.HUB_EVENT_DRIVEN = "0";
    try {
      expect(ed.isEventDrivenEnabled()).toBe(false);
      const spy = vi.fn();
      ed.startEventDrivenScheduler({ onDeadline: ed.runEventDrivenScan, onGraceExpired: spy });
      const now = Date.now();
      insertTask({ id: "disabled", status: "assigned", updated_at: now, due_at: now - 60_000 });

      ed.notifyScheduleChanged();
      ed.onClientDisconnected("disabled-agent");
      await wait(80);

      // 到期 timer 未启动 → 任务不被释放；宽限期未启动 → 不触发回调
      expect(taskById("disabled").status).toBe("assigned");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.HUB_EVENT_DRIVEN = "1";
    }
  });
});
