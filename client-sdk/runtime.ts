/**
 * runtime.ts — 自主 Agent 执行闭环运行时原语（Feature A）
 *
 * 包裹既有 AgentClient，让 Agent 收到任务后自动：
 *   标记 in_progress → 调宿主注入的 execute() → 回写 completed/failed
 * 从而消灭人工中转。Hub 始终是纯协调层，execute() 由宿主实现、完全不感知。
 *
 * 内置护栏（通用逻辑，所有宿主复用）：
 *   - 幂等去重（inFlight 按 task.id）：实时推 + 重连补发只执行一次
 *   - 并发上限（maxConcurrent）：防止失控
 *   - 崩溃恢复（requeueIncomplete）：启动重跑 in_progress/assigned 卡死任务
 *   - 防自杀循环（loopGuard）：窗口内相同 description 重分配超阈值即跳过
 *   - 授权挂起/超时：execute() 内调 requestAuthorization 接入 Feature B
 */
import {
  AgentClient,
  type TaskEvent,
  type MessageEvent,
  type SensitiveOp,
  AuthorizationRejected,
  AuthorizationExpired,
} from "./agent-client.js";

/** 敏感操作描述（传入 requestAuthorization） */
export type { SensitiveOp } from "./agent-client.js";

export interface AgentRuntimeOptions {
  /** 并发执行上限，默认 4 */
  maxConcurrent?: number;
  /** 启动时重跑 in_progress/assigned 的崩溃恢复，默认 true */
  requeueIncomplete?: boolean;
  /** 防自杀式循环 */
  loopGuard?: {
    /** 相同 description 重分配的判定窗口（ms），默认 30000 */
    windowMs?: number;
    /** 窗口内最多允许几次，超过则跳过，默认 2 */
    maxIdentical?: number;
  };
  /** 指向自己的 new_message 可选反应 */
  onSelfMessage?: (msg: MessageEvent) => Promise<void>;
  /** 任务执行出错回调（含授权被拒/过期） */
  onError?: (taskId: string, err: unknown) => void;
}

export type ExecuteFn = (task: TaskEvent) => Promise<string>;

export class AgentRuntime {
  private client: AgentClient;
  private execute: ExecuteFn;
  private opts: AgentRuntimeOptions;

  private inFlight = new Set<string>();
  private maxConcurrent: number;
  private requeueIncomplete: boolean;
  private loopGuard: { windowMs: number; maxIdentical: number };
  private recentDescriptions: { desc: string; ts: number }[] = [];

  private started = false;
  private stopped = false;

  // 绑定 this，便于 client.on/off 注册/注销
  private handleAssignedBound = (task: TaskEvent): void => {
    void this.handleAssigned(task);
  };
  private handleMessageBound = (msg: MessageEvent): void => {
    void this.handleMessage(msg);
  };

  constructor(
    client: AgentClient,
    execute: ExecuteFn,
    opts: AgentRuntimeOptions = {},
  ) {
    this.client = client;
    this.execute = execute;
    this.opts = opts;
    this.maxConcurrent = opts.maxConcurrent ??
      parseInt(process.env.RUNTIME_MAX_CONCURRENT ?? "4", 10);
    this.requeueIncomplete = opts.requeueIncomplete ?? true;
    this.loopGuard = {
      windowMs: opts.loopGuard?.windowMs ??
        parseInt(process.env.RUNTIME_LOOP_GUARD_MS ?? "30000", 10),
      maxIdentical: opts.loopGuard?.maxIdentical ?? 2,
    };
  }

  /** 接线 onTaskAssigned / onMessage；可选崩溃恢复重跑 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    // 包裹 AgentClient 现有 onTaskAssigned / onMessage 回调（经 EventEmitter）
    this.client.on("task_assigned", this.handleAssignedBound);
    this.client.on("new_message", this.handleMessageBound);

    // 崩溃恢复：重跑未完成任务（去重保护防双跑）
    if (this.requeueIncomplete) {
      await this.requeueIncompleteTasks();
    }
  }

  /** 停止接收；拒绝所有挂起的授权 Promise（由 AgentClient.stop 兜底） */
  stop(): void {
    this.stopped = true;
    this.client.off("task_assigned", this.handleAssignedBound);
    this.client.off("new_message", this.handleMessageBound);
  }

  /** 在 execute() 内部调用：提交授权请求并挂起，批准后 resolve，拒绝/过期 reject */
  requestAuthorization(op: SensitiveOp): Promise<void> {
    return this.client.requestAuthorization(op);
  }

  // ─── 收到任务：驱动状态机 + 护栏 ───────────────────────
  private async handleAssigned(task: TaskEvent): Promise<void> {
    if (this.stopped) return;
    if (!task?.id) return;

    // 1. 幂等去重（实时推 + 补发重复执行保护）
    if (this.inFlight.has(task.id)) return;

    // 2. 防自杀循环
    if (this.isLoopGuardHit(task)) {
      console.warn(
        `[AgentRuntime] loop_guard_skip: task ${task.id} (${task.description}) 命中自杀循环护栏，已跳过`
      );
      return;
    }

    this.inFlight.add(task.id);
    try {
      // 标记为进行中（progress 5）
      await this.client.updateTaskStatus(task.id, "in_progress", undefined, 5);

      // 执行宿主注入的逻辑
      const result = await this.execute(task);
      if (this.stopped) return;

      // 成功 → completed
      await this.client.updateTaskStatus(task.id, "completed", result, 100);
    } catch (err) {
      await this.handleExecuteError(task, err);
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  // ─── 收到消息：指向自己时触发可选反应 ─────────────────
  private async handleMessage(msg: MessageEvent): Promise<void> {
    if (this.stopped) return;
    if (msg.to_agent === this.client.agentId && this.opts.onSelfMessage) {
      await this.opts.onSelfMessage(msg);
    }
  }

  // ─── 执行出错：按错误类型回写 failed ──────────────────
  private async handleExecuteError(task: TaskEvent, err: unknown): Promise<void> {
    let label = "unknown op";
    let reason: string | undefined;
    if (err instanceof AuthorizationRejected) {
      label = `${err.op.type}: ${err.op.description}`;
      reason = err.reason;
    } else if (err instanceof AuthorizationExpired) {
      label = `${err.op.type}: ${err.op.description}`;
    } else {
      const op = (err as { op?: SensitiveOp })?.op;
      if (op) label = `${op.type}: ${op.description}`;
    }
    try {
      if (err instanceof AuthorizationRejected) {
        const r = reason ? ` - ${reason}` : "";
        await this.client.updateTaskStatus(task.id, "failed", `授权被拒: ${label}${r}`);
      } else if (err instanceof AuthorizationExpired) {
        await this.client.updateTaskStatus(task.id, "failed", `授权过期未处理: ${label}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await this.client.updateTaskStatus(task.id, "failed", msg);
      }
    } catch (statusErr) {
      console.error(`[AgentRuntime] 回写任务 ${task.id} 失败状态出错:`, statusErr);
    }
    this.opts.onError?.(task.id, err);
  }

  // ─── 崩溃恢复：重跑 in_progress / assigned 任务 ───────
  private async requeueIncompleteTasks(): Promise<void> {
    try {
      const statuses = ["in_progress", "assigned"];
      const tasks: TaskEvent[] = [];
      for (const status of statuses) {
        const data = await this.client.getTasks(status);
        const list = Array.isArray(data) ? data : (data?.tasks ?? []);
        for (const t of list) {
          if (t?.id) tasks.push(t as TaskEvent);
        }
      }
      if (tasks.length === 0) return;
      console.log(`[AgentRuntime] 崩溃恢复：重跑 ${tasks.length} 个未完成任务`);
      await this.runWithConcurrency(tasks, this.maxConcurrent, (t) => this.handleAssigned(t));
    } catch (err) {
      console.error(`[AgentRuntime] 崩溃恢复重跑失败:`, err);
    }
  }

  // ─── 小工具：有上限的并发执行 ─────────────────────────
  private async runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    };
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // ─── loopGuard：窗口内相同 description 重分配超阈值 ───
  private isLoopGuardHit(task: TaskEvent): boolean {
    const now = Date.now();
    // 清理窗口外记录
    this.recentDescriptions = this.recentDescriptions.filter(
      (e) => now - e.ts < this.loopGuard.windowMs
    );
    const sameCount = this.recentDescriptions.filter(
      (e) => e.desc === task.description
    ).length;
    // 记录本次（不论是否跳过，保留审计信号）
    this.recentDescriptions.push({ desc: task.description, ts: now });
    // 窗口内已存在 >= maxIdentical 条相同描述 → 跳过（避免自杀式循环）
    return sameCount >= this.loopGuard.maxIdentical;
  }
}

/**
 * 便捷工厂：一行获得自主执行能力
 *   const rt = runAutonomousLoop(client, async (task) => { ... return result; });
 *   rt.start();
 */
export function runAutonomousLoop(
  client: AgentClient,
  execute: ExecuteFn,
  opts?: AgentRuntimeOptions
): AgentRuntime {
  return new AgentRuntime(client, execute, opts);
}
