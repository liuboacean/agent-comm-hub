/**
 * repo/event-log.d.ts — 持久化 SSE 事件日志类型声明（D1）
 */
export interface StoredEvent {
    id: number;
    agent_id: string;
    event_type: string;
    payload: string;
    delivered: number;
    created_at: number;
}
export declare const eventLogRepo: {
    appendEvent(agentId: string, eventType: string, payload: string): number;
    getEventsAfter(seq: number, agentId: string, limit?: number): StoredEvent[];
    getUndelivered(agentId: string, limit?: number): StoredEvent[];
    markDelivered(seq: number): void;
};
