export declare function stuckThresholdMs(): number;
/** 是否启用事件驱动（默认关闭：opt-in，与批处理同款保守策略） */
export declare function isEventDrivenEnabled(): boolean;
export interface EventSpec {
    agentId: string;
    event: object;
    dedupId?: string;
}
/**
 * 只把事件持久化到 event_log（delivered=0），返回全局单调 seq。
 * 不投递。供事务内调用。
 */
export declare function emitEvent(agentId: string, event: object, dedupId?: string): number;
/**
 * 投递一条【已持久化】的事件（按 seq 读取），成功写入才标记 delivered=1。
 * - 幂等：delivered=1 的事件直接返回 true，不重复落网。
 * - 无本地 SSE 连接：保持 delivered=0，靠首连/重连 replay 兜底（至少一次）。
 * - 与 deliverToLocalClient 一致，投递时才补 _hub_event_id=seq（D1 契约）。
 * 注意：此路径【同步】投递，不走批处理窗口；跨进程桥接仍走原 pushToAgent 路径。
 */
export declare function dispatchPersistedEvent(seq: number): boolean;
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
export declare function withEvents<T>(business: () => T, events: EventSpec[] | ((result: T) => EventSpec[])): T;
/**
 * 计算全局最早到期时间：每个 assigned/in_progress 任务的
 * MIN(due_at, updated_at + stuckMs)，取全表最小值。返回绝对时间戳（ms），无任务则 null。
 */
export declare function computeNextDeadline(): number | null;
/** 任务状态/截止时间变更后调用：重新计算最早到期（关闭时 no-op） */
export declare function notifyScheduleChanged(): void;
/**
 * 事务化的到期扫描：复用 P0 的 findStuckTasks / releaseTaskToInbox，
 * 但把「释放 + 审计 + 通知事件落库」放在同一事务（A1 的真实生产落点）。
 * P0 的 runWatchdogScan() 保持原样，作为低频兜底。
 */
export declare function runEventDrivenScan(): {
    scanned: number;
    released: number;
};
/** SSE 连接建立：取消该 Agent 的断线宽限期（重连不误判离线） */
export declare function onClientConnected(agentId: string): void;
/** SSE 断线：启动宽限期 timer，到期仍未重连才释放孤儿任务（幂等） */
export declare function onClientDisconnected(agentId: string): void;
/** 启动调度器。关闭时不注册任何 timer，行为与 P1 完全一致。 */
export declare function startEventDrivenScheduler(handlers: {
    onDeadline?: () => {
        scanned: number;
        released: number;
    };
    onGraceExpired?: (agentId: string) => void;
}): void;
/** 停止调度器并清空全部 timer（gracefulShutdown 必须在 drain 之前调用，避免误释放） */
export declare function stopEventDrivenScheduler(): void;
