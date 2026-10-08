export interface StoredEvent {
    id: number;
    agent_id: string;
    event_type: string;
    payload: string;
    delivered: number;
    created_at: number;
}
declare class EventLogRepo {
    /**
     * 追加一条事件到持久化日志，返回全局单调 seq（即 SSE 的 id）
     */
    appendEvent(agentId: string, eventType: string, payload: string): number;
    /**
     * 取出 seq 之后（不含 seq）该 Agent 的全部事件，按 seq 升序。
     * 用于断线重连的精确补发（覆盖所有事件类型）。
     */
    getEventsAfter(seq: number, agentId: string, limit?: number): StoredEvent[];
    /**
     * 取出该 Agent 尚未投递（delivered=0）的事件，按 seq 升序。
     * 用于首连补发（agent 离线期间累积的事件）。
     */
    getUndelivered(agentId: string, limit?: number): StoredEvent[];
    /** 标记某条事件已成功投递（仅成功推送才标记，见 D1） */
    markDelivered(seq: number): void;
}
export declare const eventLogRepo: EventLogRepo;
export {};
