/**
 * db.ts — SQLite 持久化层
 * 消息 + 任务 两张表，进程重启数据不丢失
 */
import { type Database as DatabaseType, type Statement } from "better-sqlite3";
export declare const db: DatabaseType;
export interface Message {
    id: string;
    from_agent: string;
    to_agent: string;
    content: string;
    type: "message" | "task_assign" | "task_update" | "ack";
    metadata?: string | null;
    status: "unread" | "delivered" | "read" | "acknowledged";
    created_at: number;
}
export declare const msgStmt: Record<string, Statement>;
export interface ConsumedEntry {
    id: string;
    agent_id: string;
    resource: string;
    resource_type: string;
    action: string;
    notes?: string | null;
    consumed_at: number;
}
export declare const consumedStmt: Record<string, Statement>;
export interface Task {
    id: string;
    assigned_by: string;
    assigned_to: string;
    description: string;
    context?: string | null;
    priority: "low" | "normal" | "high" | "urgent";
    status: "inbox" | "assigned" | "waiting" | "pending" | "in_progress" | "completed" | "failed" | "cancelled";
    result?: string | null;
    progress: number;
    pipeline_id?: string | null;
    order_index: number;
    required_capability?: string | null;
    due_at?: number | null;
    assigned_at?: number | null;
    completed_at?: number | null;
    tags?: string | null;
    parallel_group?: string | null;
    handoff_status?: string | null;
    handoff_to?: string | null;
    created_at: number;
    updated_at: number;
}
export declare const taskStmt: Record<string, Statement>;
export interface Pipeline {
    id: string;
    name: string;
    description?: string | null;
    status: "draft" | "active" | "completed" | "cancelled";
    creator: string;
    config?: string | null;
    created_at: number;
    updated_at: number;
}
export interface PipelineTask {
    id: string;
    pipeline_id: string;
    task_id: string;
    order_index: number;
    created_at: number;
}
export declare const pipelineStmt: Record<string, Statement>;
export declare const pipelineTaskStmt: Record<string, Statement>;
export declare function getDbStats(): Record<string, number>;
/**
 * 定时清理过期数据（每小时执行一次）
 * - 过期的 API Token（token_type='api_token'）
 * - 过期的去重缓存（超过 dedupTTL 秒）
 * - 过期的消费日志（>1天）
 */
export declare function scheduleCleanup(dedupTTL: number): void;
export declare function stopCleanup(): void;
