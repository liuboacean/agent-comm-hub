/**
 * sse.ts — SSE 连接管理 (Phase 1 Week 2 增强)
 * 维护 AgentID → Response 映射，实现零轮询实时推送
 *
 * Week 2 增强：
 *   - pushToAgent 支持可选的 dedup_id，用于客户端去重
 *   - 每个 SSE 事件附加 event_id（递增），客户端可据此去重
 */
import type { Response } from "express";
import { type StoredEvent } from "./repo/event-log.js";
export declare const MAX_SSE_CONNECTIONS = 200;
/**
 * 启动僵尸连接清理（每 5 分钟检测 1 次，心跳超时 10 分钟自动移除）
 */
export declare function startZombieCleanup(timeoutMs?: number): void;
export declare function stopZombieCleanup(): void;
/**
 * 获取下一个 event_id（不递增，预览用）
 */
export declare function peekNextEventId(agentId: string): number;
/**
 * 注册 Agent 的 SSE 连接
 * @returns 本次连接的唯一 connId，调用方应在 close 回调中回传，
 *          以便 removeClient 区分「旧连接关闭」与「当前连接关闭」。
 */
export declare function registerClient(agentId: string, res: Response): number;
/**
 * 移除 Agent 连接（断线时调用）
 * @param connId 可选。传入时仅当该 agent 的「当前」连接 connId 与之匹配才移除，
 *              用于忽略「已被新连接取代的旧 socket 的 close 事件」（P1-1 修复）。
 *              不传（drain / 僵尸清理）则无条件移除。
 */
export declare function removeClient(agentId: string, connId?: number): void;
/**
 * 向指定 Agent 推送事件。
 *
 * D1 修复：每次推送先持久化到 event_log 取得**全局单调 seq**，并以该 seq 作为
 * SSE `id` 发送。这样断线重连时客户端回传 Last-Event-ID=seq，服务端可精确补发
 * id > seq 的事件（覆盖所有事件类型）；离线时事件已落库，首连/重连补发不丢。
 * 仅当本次写入响应成功才标记 delivered，推送失败不标记、待重试。
 *
 * @param agentId 目标 Agent
 * @param event 事件数据（会被序列化为 JSON，其 `event` 字段作为 event_type）
 * @param dedupId 可选的去重标识（如 msg_hash），附加到事件中供客户端验证
 * @returns true = 在线且已成功推送；false = 离线或推送失败（事件仍落库，待补发）
 */
export declare function pushToAgent(agentId: string, event: object, dedupId?: string): boolean;
/**
 * 从持久化事件日志回放一条已存储事件（重连/首连补发路径）。
 * 直接使用存储的 seq 作为 SSE id，不会再次写入 event_log（避免无限递归）。
 * @returns true = 成功写入响应；false = 离线或写入失败
 */
export declare function writeStoredEvent(agentId: string, ev: StoredEvent): boolean;
/**
 * 广播给多个 Agent
 */
export declare function broadcast(agentIds: string[], event: object): Record<string, boolean>;
/**
 * SSE 广播：推送给所有已连接 Agent（P1-4 激活态变更广播）
 */
export declare function broadcastToAll(event: object): Record<string, boolean>;
/**
 * 查询哪些 Agent 在线
 */
export declare function onlineAgents(): string[];
export declare function connectedCount(): number;
/**
 * Phase 5b: 优雅关闭时 drain 所有 SSE 连接
 * 向每个客户端发送 close 事件后关闭连接
 */
export declare function drainAllClients(): void;
