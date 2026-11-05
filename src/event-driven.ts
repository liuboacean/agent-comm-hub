/**
 * event-driven.ts — P2-A 事件驱动（确定性，零 LLM）
 *
 * 借鉴 DeepSeek Super-Agent「事件驱动」思想，但严格守住 Hub 铁律：
 * 零 LLM、纯确定性、复用 event_log 的 WORM 事件流、不引入外部消息队列。
 *
 * ─── A1: outbox-lite（事务化事件发射） ──────────────────────
 * 问题：原 pushToAgent() 在业务写之后才 appendEvent，两者不在同一事务。
 *       业务写成功但推送失败 → 事件留 delivered=0 靠重连补发（至少一次，安全）；
 *       但若业务事务回滚而事件已落库/已推送 → 幽灵通知。
 * 方案：复用 event_log.delivered=0 作为待发队列（不新建表）。
 *       withEvents(business, events) 把「业务写 + 事件落库」放进同一事务，
 *       事务提交后才【同步】dispatch；回滚则事件一并回滚，绝不外发。
 *       pushToAgent() 对外契约与现有调用方零改动（渐进迁移，opt-in）。
 *
 * ─── A2: 到期驱动（替代高频时间巡检） ──────────────────────
 * 现状：Watchdog 每 5min 全表扫卡死任务、心跳每 90s 扫离线 Agent。
 * 方案：从 tasks 表算出全局最早到期时间 MIN(due_at, updated_at + stuckMs)，
 *       用【单个 timer】到点触发一次精确扫描（runEventDrivenScan）；
 *       SSE 断线启动 90s 宽限期 timer（重连即取消，到期才释放孤儿任务）。
 *       Watchdog / 心跳保留为低频兜底，防进程重启丢 timer。
 *       定时器 unref()，不阻止进程退出。
 *
 * 开关：HUB_EVENT_DRIVEN=1 启用，默认 0（关闭，opt-in）。关闭时所有挂钩为 no-op，
 *       行为与 P1 完全一致（零回归），可用 HUB_EVENT_DRIVEN=0 一键回滚。
 */
import { db, transaction, findStuckTasks, releaseTaskToInbox } from "./db.js";
import { eventLogRepo, type StoredEvent } from "./repo/event-log.js";
import { deliverToLocalClient } from "./sse.js";
import { auditLog } from "./security.js";
import { logger, logError } from "./logger.js";

// ─── 配置 ──────────────────────────────────────────────────
const DEFAULT_STUCK_MS = 30 * 60 * 1000;       // 卡死阈值，与 P0 runWatchdogScan 一致
const DEFAULT_GRACE_MS = 90 * 1000;            // SSE 断线宽限期，与心跳离线阈值一致
const DEFAULT_MAX_DELAY_MS = 30 * 60 * 1000;   // 单 timer 最大延迟（clamp 后周期性重算）

function parsePositiveEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function stuckThresholdMs(): number {
  return parsePositiveEnv("WATCHDOG_STUCK_MS", DEFAULT_STUCK_MS);
}
function graceMs(): number {
  return parsePositiveEnv("HUB_EVENT_GRACE_MS", DEFAULT_GRACE_MS);
}
function maxDelayMs(): number {
  return parsePositiveEnv("HUB_EVENT_MAX_DELAY_MS", DEFAULT_MAX_DELAY_MS);
}

/** 是否启用事件驱动（默认关闭：opt-in，与批处理同款保守策略） */
export function isEventDrivenEnabled(): boolean {
  return process.env.HUB_EVENT_DRIVEN === "1";
}

// 调度器只有在 start 之后才算 active；withEvents 是纯 API，不受 running 限制。
let running = false;
function isActive(): boolean {
  return running && isEventDrivenEnabled();
}

// ═══════════════════════════════════════════════════════════
// A1: outbox-lite（事务化事件发射）
// ═══════════════════════════════════════════════════════════

export interface EventSpec {
  agentId: string;
  event: object;
  dedupId?: string;
}

/**
 * 只把事件持久化到 event_log（delivered=0），返回全局单调 seq。
 * 不投递。供事务内调用。
 */
export function emitEvent(agentId: string, event: object, dedupId?: string): number {
  const eventType = String((event as Record<string, unknown>).event ?? "event");
  const payload: Record<string, unknown> = {
    ...(event as Record<string, unknown>),
    ...(dedupId ? { _hub_dedup_id: dedupId } : {}),
  };
  return eventLogRepo.appendEvent(agentId, eventType, JSON.stringify(payload));
}

/**
 * 投递一条【已持久化】的事件（按 seq 读取），成功写入才标记 delivered=1。
 * - 幂等：delivered=1 的事件直接返回 true，不重复落网。
 * - 无本地 SSE 连接：保持 delivered=0，靠首连/重连 replay 兜底（至少一次）。
 * - 与 deliverToLocalClient 一致，投递时才补 _hub_event_id=seq（D1 契约）。
 * 注意：此路径【同步】投递，不走批处理窗口；跨进程桥接仍走原 pushToAgent 路径。
 */
export function dispatchPersistedEvent(seq: number): boolean {
  let row: StoredEvent | undefined;
  try {
    row = db.prepare("SELECT * FROM event_log WHERE id=?").get(seq) as StoredEvent | undefined;
  } catch (err) {
    logError("event_driven_event_read_failed", err, { module: "event_driven", seq });
    return false;
  }
  if (!row) return false;
  if (row.delivered === 1) return true; // 幂等：已投递不重复发

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.payload) as Record<string, unknown>;
  } catch (err) {
    logError("event_driven_payload_parse_failed", err, { module: "event_driven", seq });
    return false;
  }
  const { _hub_dedup_id, ...cleanEvent } = parsed;
  const dedupId = typeof _hub_dedup_id === "string" ? _hub_dedup_id : undefined;

  const ok = deliverToLocalClient(row.agent_id, cleanEvent, dedupId, seq);
  if (ok) eventLogRepo.markDelivered(seq);
  return ok;
}

/**
 * 把「业务写 + 事件落库」放进同一事务，提交后【同步】投递。
 *
 * @param business  业务写（可返回任意结果；抛错则整个事务回滚，事件绝不外发）
 * @param events    事件数组，或按 business 结果动态生成的函数（便于条件事件）
 *
 * 保证：
 *   - business 抛错 / emitEvent 抛错 → 事务回滚 → 无幽灵通知。
 *   - 事务提交 → 事件必落库；dispatch 失败留 delivered=0，靠重连补发（至少一次）。
 *   - dispatch 同步完成（成功即 delivered=1），不破坏 D1 同步可靠性契约。
 */
export function withEvents<T>(
  business: () => T,
  events: EventSpec[] | ((result: T) => EventSpec[]),
): T {
  const seqs: number[] = [];
  const result = transaction(() => {
    const r = business();
    const specs = typeof events === "function" ? events(r) : events;
    for (const spec of specs) {
      seqs.push(emitEvent(spec.agentId, spec.event, spec.dedupId));
    }
    return r;
  });

  // 事务已提交：同步投递。单条失败不影响其它事件，也不让异常回吐到业务调用方。
  for (const seq of seqs) {
    try {
      dispatchPersistedEvent(seq);
    } catch (err) {
      logError("event_driven_dispatch_failed", err, { module: "event_driven", seq });
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════
// A2: 到期驱动调度
// ═══════════════════════════════════════════════════════════

let deadlineTimer: NodeJS.Timeout | null = null;
const graceTimers = new Map<string, NodeJS.Timeout>();
let deadlineHandler: (() => { scanned: number; released: number }) | null = null;
let graceHandler: ((agentId: string) => void) | null = null;

/**
 * 计算全局最早到期时间：每个 assigned/in_progress 任务的
 * MIN(due_at, updated_at + stuckMs)，取全表最小值。返回绝对时间戳（ms），无任务则 null。
 */
export function computeNextDeadline(): number | null {
  const sm = stuckThresholdMs();
  const row = db.prepare(
    `SELECT MIN(
       CASE
         WHEN due_at IS NOT NULL AND due_at < updated_at + ? THEN due_at
         ELSE updated_at + ?
       END
     ) AS next_at
     FROM tasks
     WHERE status IN ('assigned','in_progress')`
  ).get(sm, sm) as { next_at: number | null } | undefined;
  return row?.next_at ?? null;
}

function clearDeadlineTimer(): void {
  if (deadlineTimer) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
}

function armTimer(fn: () => void, delay: number): NodeJS.Timeout {
  const t = setTimeout(fn, delay);
  t.unref(); // 不阻止进程退出
  return t;
}

/** 重新计算并注册下一个到期 timer（只用单个 timer，不按任务数增长） */
function scheduleNextDeadline(): void {
  if (!isActive()) return;
  clearDeadlineTimer();
  const next = computeNextDeadline();
  if (next === null) return;

  const now = Date.now();
  const overdue = next <= now;
  const delay = Math.max(0, Math.min(next - now, maxDelayMs()));

  deadlineTimer = armTimer(() => {
    deadlineTimer = null;
    let released = 0;
    try {
      released = deadlineHandler?.().released ?? 0;
    } catch (err) {
      logError("event_driven_deadline_scan_failed", err, { module: "event_driven" });
    }
    // 防自旋：已过期但扫描未释放任何任务（如状态被外部改动），退避 1min 后重算。
    if (overdue && released === 0) {
      deadlineTimer = armTimer(() => {
        deadlineTimer = null;
        scheduleNextDeadline();
      }, Math.min(maxDelayMs(), 60_000));
      return;
    }
    scheduleNextDeadline();
  }, delay);
}

/** 任务状态/截止时间变更后调用：重新计算最早到期（关闭时 no-op） */
export function notifyScheduleChanged(): void {
  if (!isActive()) return;
  scheduleNextDeadline();
}

/**
 * 事务化的到期扫描：复用 P0 的 findStuckTasks / releaseTaskToInbox，
 * 但把「释放 + 审计 + 通知事件落库」放在同一事务（A1 的真实生产落点）。
 * P0 的 runWatchdogScan() 保持原样，作为低频兜底。
 */
export function runEventDrivenScan(): { scanned: number; released: number } {
  const sm = stuckThresholdMs();
  const tasks = findStuckTasks(sm);
  let released = 0;
  for (const task of tasks) {
    const ok = withEvents(
      () => {
        if (!releaseTaskToInbox(task.id)) return false;
        auditLog("task_released_stuck", task.assigned_to || "system", task.id,
          `event_driven deadline hit; prev_status=${task.status} prev_assignee=${task.assigned_to || "none"}`);
        return true;
      },
      (success: boolean): EventSpec[] =>
        success && task.assigned_by
          ? [{
              agentId: task.assigned_by,
              event: {
                event: "task_released",
                task_id: task.id,
                reason: "task_deadline_reached",
                assigned_to: task.assigned_to,
                description: task.description,
                message: `任务「${task.description}」已到达到期时间，已退回收件箱等待重新分配。`,
              },
            }]
          : []
    );
    if (ok) released++;
  }
  return { scanned: tasks.length, released };
}

/** SSE 连接建立：取消该 Agent 的断线宽限期（重连不误判离线） */
export function onClientConnected(agentId: string): void {
  const t = graceTimers.get(agentId);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(agentId);
  }
}

/** SSE 断线：启动宽限期 timer，到期仍未重连才释放孤儿任务（幂等） */
export function onClientDisconnected(agentId: string): void {
  if (!isActive()) return;
  onClientConnected(agentId); // 清掉旧 timer
  const t = armTimer(() => {
    graceTimers.delete(agentId);
    try {
      graceHandler?.(agentId);
    } catch (err) {
      logError("event_driven_grace_release_failed", err, { module: "event_driven", agent_id: agentId });
    }
    scheduleNextDeadline();
  }, graceMs());
  graceTimers.set(agentId, t);
}

/** 启动调度器。关闭时不注册任何 timer，行为与 P1 完全一致。 */
export function startEventDrivenScheduler(handlers: {
  onDeadline?: () => { scanned: number; released: number };
  onGraceExpired?: (agentId: string) => void;
}): void {
  deadlineHandler = handlers.onDeadline ?? null;
  graceHandler = handlers.onGraceExpired ?? null;
  if (!isEventDrivenEnabled()) {
    logger.info("event_driven_disabled", { module: "event_driven", note: "HUB_EVENT_DRIVEN=0 (opt-in)" });
    return;
  }
  running = true;
  scheduleNextDeadline(); // 启动即重建：从 DB 现有任务算出最早到期
  logger.info("event_driven_started", {
    module: "event_driven",
    stuck_ms: stuckThresholdMs(),
    grace_ms: graceMs(),
    next_deadline: computeNextDeadline(),
  });
}

/** 停止调度器并清空全部 timer（gracefulShutdown 必须在 drain 之前调用，避免误释放） */
export function stopEventDrivenScheduler(): void {
  running = false;
  clearDeadlineTimer();
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  deadlineHandler = null;
  graceHandler = null;
  logger.info("event_driven_stopped", { module: "event_driven" });
}
