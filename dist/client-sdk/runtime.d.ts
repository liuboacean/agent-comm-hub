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
import { AgentClient, type TaskEvent, type MessageEvent, type SensitiveOp } from "./agent-client.js";
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
export declare class AgentRuntime {
    private client;
    private execute;
    private opts;
    private inFlight;
    private maxConcurrent;
    private requeueIncomplete;
    private loopGuard;
    private recentDescriptions;
    private started;
    private stopped;
    private handleAssignedBound;
    private handleMessageBound;
    constructor(client: AgentClient, execute: ExecuteFn, opts?: AgentRuntimeOptions);
    /** 接线 onTaskAssigned / onMessage；可选崩溃恢复重跑 */
    start(): Promise<void>;
    /** 停止接收；拒绝所有挂起的授权 Promise（由 AgentClient.stop 兜底） */
    stop(): void;
    /** 在 execute() 内部调用：提交授权请求并挂起，批准后 resolve，拒绝/过期 reject */
    requestAuthorization(op: SensitiveOp): Promise<void>;
    private handleAssigned;
    private handleMessage;
    private handleExecuteError;
    private requeueIncompleteTasks;
    private runWithConcurrency;
    private isLoopGuardHit;
}
/**
 * 便捷工厂：一行获得自主执行能力
 *   const rt = runAutonomousLoop(client, async (task) => { ... return result; });
 *   rt.start();
 */
export declare function runAutonomousLoop(client: AgentClient, execute: ExecuteFn, opts?: AgentRuntimeOptions): AgentRuntime;
