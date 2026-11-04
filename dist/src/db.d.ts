/**
 * db.ts — SQLite 持久化层
 * 消息 + 任务 两张表，进程重启数据不丢失
 */
import { type Database as DatabaseType, type Statement } from "better-sqlite3";
export declare const db: DatabaseType;
export declare function transaction<T>(fn: () => T): T;
export interface Subscription {
    id: string;
    agent_id: string;
    event_type: string;
    topic_filter: string;
    created_at: number;
}
export declare const subscriptionStmt: Record<string, Statement>;
/**
 * 订阅事件（幂等：基于唯一约束，重复订阅静默忽略）。
 * @param eventType '*' 或空表示订阅全部事件类型
 * @param topicFilter 空表示不限主题；非空为对事件 payload JSON 的子串过滤
 */
export declare function subscribeEvent(agentId: string, eventType: string, topicFilter: string): void;
/**
 * 退订。
 * - 若 eventType 与 topicFilter 均为默认（'*'/空），则清空该 Agent 的全部订阅；
 * - 否则仅删除精确匹配的那一条规则。
 * @returns 受影响行数
 */
export declare function unsubscribeEvent(agentId: string, eventType?: string, topicFilter?: string): number;
/** 查询某 Agent 的全部订阅规则 */
export declare function getSubscriptions(agentId: string): Subscription[];
/** 查询全量订阅规则（用于启动时构建内存缓存） */
export declare function getAllSubscriptions(): Subscription[];
/**
 * 纯函数：判断某事件是否命中 Agent 的订阅规则集合。
 * - 任一规则命中即返回 true（应投递）；
 * - 全部不命中返回 false（剪枝掉）。
 * 匹配规则：
 *   - event_type：空或 '*' 匹配任意类型；否则须与事件类型相等；
 *   - topic_filter：空匹配任意主题；否则事件 payload JSON 串须包含该子串。
 */
export declare function subscriptionMatches(eventType: string, payloadStr: string, subs: Subscription[]): boolean;
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
/**
 * 查询某 Agent 处于指定状态的任务（用于离线释放）。
 */
export declare function findTasksByAgentStatus(agentId: string, statuses: string[]): Task[];
/**
 * 检测卡死任务：assigned / in_progress 但长时间无进展，或已过 due_at 仍未完成。
 * @param stuckMs 无进展判定阈值（毫秒）
 */
export declare function findStuckTasks(stuckMs: number): Task[];
/**
 * 将卡死 / 离线任务安全退回收件箱（inbox），清空承接人。
 * 仅当任务仍处于 assigned / in_progress 才生效（已完成/已取消不动），幂等。
 * 返回是否实际发生了释放。
 */
export declare function releaseTaskToInbox(taskId: string): boolean;
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
export interface Attachment {
    id: string;
    message_id: string;
    filename: string;
    mime_type: string;
    file_size: number;
    storage_path: string;
    uploaded_by: string;
    created_at: number;
}
export declare const attachStmt: Record<string, Statement>;
export declare function getDbStats(): Record<string, number>;
/**
 * 归档 N 天前的消息（从 messages 移到 messages_archive）
 * @returns 归档的记录数
 */
export declare function archiveOldMessages(days?: number): number;
/**
 * 归档 N 天前的审计日志（从 audit_log 移到 audit_log_archive）
 * @returns 归档的记录数
 */
export declare function archiveOldAuditLogs(days?: number): number;
/**
 * 审计日志行数上限保护（WORM 安全）：当 audit_log 超过 maxRows 行时，
 * 将最旧的溢出行**镜像**到 audit_log_archive（按 created_at/id 升序取最旧），
 * 不删除源表记录（audit_log 为防篡改表，受 audit_log_no_delete 触发器保护）。
 *
 * 作用：audit_log 无限增长时，溢出行仍会被自动冷存到归档表，
 * 避免「归档机制空转」、并为主表查询/文件体积提供冷存分流。
 * 返回本次镜像的行数。
 */
export declare function enforceAuditLogCap(maxRows: number): number;
/**
 * 执行数据库 VACUUM（释放空闲页面，紧缩数据库文件）
 * 建议在低峰期调用（如凌晨 3-5 点）
 */
export declare function vacuumDatabase(): void;
/**
 * 获取数据库文件大小（字节）
 */
export declare function getDbSize(): number;
/**
 * 获取增强版数据库统计信息（用于 MCP 工具 get_db_stats）
 */
export declare function getEnhancedDbStats(): {
    table_counts: Record<string, number>;
    database_size_bytes: number;
    database_size_mb: number;
    wal_size_bytes: number;
    last_messages_archive: string | null;
    last_audit_log_archive: string | null;
};
/**
 * 定时清理过期数据（每小时执行一次）
 * - 过期的 API Token（token_type='api_token'）
 * - 过期的去重缓存（超过 dedupTTL 秒）
 * - 过期的消费日志（>1天）
 */
export declare function scheduleCleanup(dedupTTL: number): void;
export declare function stopCleanup(): void;
export declare function fts5IntegrityCheck(): {
    ok: boolean;
    details: string;
};
/**
 * 数据库整体完整性自检（PRAGMA integrity_check）。
 *
 * 用途：早期暴露「磁盘文件损坏」（SQLITE_CORRUPT），避免像 3.0.25 联调那样
 * 直到回写失败才在 err.log 里成片刷 `database disk image is malformed`。
 * 注意：进程重启无法修复盘损，必须由运维用 `sqlite3 .recover` 重建。
 *
 * - 健康：{ ok: true, details: "ok" }
 * - 损坏：{ ok: false, details: "<首行损坏描述>" }（最多拼接前 3 行）
 * - PRAGMA 本身抛错（库彻底打不开）：{ ok: false, details: "integrity_check_error: ..." }
 */
export declare function integrityCheckDb(): {
    ok: boolean;
    details: string;
};
