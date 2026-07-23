import { logger, logError } from "./logger.js";
import { eventLogRepo } from "./repo/event-log.js";
// 在线 Agent 连接池
const clients = new Map();
// ─── P1-1 修复：每个连接分配唯一 connId ───────────────
// 重连时旧 socket 的 close 事件若仍调用 removeClient，会误删「当前」新连接
// （clients 里已是新 res），导致实时投递静默丢失。用 connId 比对：
// 仅当 clients 中仍指向同一连接时才允许移除。
let connSeq = 0;
const clientConnIds = new Map();
// ─── P1-3 修复：SSE 连接数上限，防内存耗尽 DoS ───────
export const MAX_SSE_CONNECTIONS = 200;
// ─── 客户端去重：per-connection 递增 event_id ─────────────
const clientEventCounters = new Map();
// ─── P2-3: SSE 僵尸连接清理 ──────────────────────────────
const clientLastActivity = new Map();
let zombieCleanupTimer = null;
function touchActivity(agentId) {
    clientLastActivity.set(agentId, Date.now());
}
/**
 * 启动僵尸连接清理（每 5 分钟检测 1 次，心跳超时 10 分钟自动移除）
 */
export function startZombieCleanup(timeoutMs = 600_000) {
    if (zombieCleanupTimer)
        return;
    zombieCleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [agentId, last] of clientLastActivity.entries()) {
            if (now - last > timeoutMs) {
                const res = clients.get(agentId);
                if (res) {
                    try {
                        res.end();
                    }
                    catch { /* ignore close error */ }
                }
                // 传入当前 connId，仅当仍指向该连接时才移除
                removeClient(agentId, clientConnIds.get(agentId));
                clientLastActivity.delete(agentId);
                logger.warn("sse_zombie_removed", { module: "sse", agent_id: agentId, idle_ms: now - last });
            }
        }
    }, 300_000); // 每 5 分钟
    logger.info("sse_zombie_cleanup_started", { module: "sse", interval_ms: 300_000, timeout_ms: timeoutMs });
}
export function stopZombieCleanup() {
    if (zombieCleanupTimer) {
        clearInterval(zombieCleanupTimer);
        zombieCleanupTimer = null;
    }
}
function nextEventId(agentId) {
    const current = clientEventCounters.get(agentId) ?? 0;
    const next = current + 1;
    clientEventCounters.set(agentId, next);
    return next;
}
/**
 * 获取下一个 event_id（不递增，预览用）
 */
export function peekNextEventId(agentId) {
    return (clientEventCounters.get(agentId) ?? 0) + 1;
}
/**
 * 注册 Agent 的 SSE 连接
 * @returns 本次连接的唯一 connId，调用方应在 close 回调中回传，
 *          以便 removeClient 区分「旧连接关闭」与「当前连接关闭」。
 */
export function registerClient(agentId, res) {
    // 如果已有旧连接，先关掉（Agent 重启场景）
    const existing = clients.get(agentId);
    if (existing) {
        try {
            existing.end();
        }
        catch (err) {
            logger.debug("sse_old_connection_close_error", { module: "sse", agent_id: agentId });
        }
    }
    clients.set(agentId, res);
    const connId = ++connSeq;
    clientConnIds.set(agentId, connId);
    // 重置 event counter
    clientEventCounters.set(agentId, 0);
    touchActivity(agentId);
    logger.info("sse_client_connected", { module: "sse", agent_id: agentId, total: clients.size, conn_id: connId });
    return connId;
}
/**
 * 移除 Agent 连接（断线时调用）
 * @param connId 可选。传入时仅当该 agent 的「当前」连接 connId 与之匹配才移除，
 *              用于忽略「已被新连接取代的旧 socket 的 close 事件」（P1-1 修复）。
 *              不传（drain / 僵尸清理）则无条件移除。
 */
export function removeClient(agentId, connId) {
    if (connId !== undefined && clientConnIds.get(agentId) !== connId) {
        // 旧连接的 close 事件：当前连接已更替，忽略，避免误删实时链路
        return;
    }
    clients.delete(agentId);
    clientEventCounters.delete(agentId);
    clientConnIds.delete(agentId);
    logger.info("sse_client_disconnected", { module: "sse", agent_id: agentId, total: clients.size });
}
/** 连接是否仍可写（P2-5 修复：防 write-after-end 噪声） */
function isWritable(res) {
    return !res.writableEnded && !res.destroyed && res.writable;
}
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
export function pushToAgent(agentId, event, dedupId) {
    const eventType = event.event ?? "event";
    const payload = {
        ...event,
        ...(dedupId ? { _hub_dedup_id: dedupId } : {}),
    };
    // 1. 先持久化，取得全局单调 seq
    let seq;
    try {
        seq = eventLogRepo.appendEvent(agentId, String(eventType), JSON.stringify(payload));
    }
    catch (err) {
        logError("sse_event_log_append_failed", err, { module: "sse", agent_id: agentId });
        return false;
    }
    const res = clients.get(agentId);
    if (!res) {
        // 离线：事件已持久化，等待首连 / 重连补发
        return false;
    }
    if (!isWritable(res)) {
        // P2-5 修复：连接已关闭，勿写，退回离线补发路径
        return false;
    }
    // 2. 在线：以全局 seq 作为 SSE id 发送，仅成功才标记 delivered
    try {
        payload._hub_event_id = seq;
        res.write(`id: ${seq}\n`);
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        touchActivity(agentId);
        eventLogRepo.markDelivered(seq);
        return true;
    }
    catch (err) {
        // 连接异常，移除
        removeClient(agentId);
        return false;
    }
}
/**
 * 从持久化事件日志回放一条已存储事件（重连/首连补发路径）。
 * 直接使用存储的 seq 作为 SSE id，不会再次写入 event_log（避免无限递归）。
 * @returns true = 成功写入响应；false = 离线或写入失败
 */
export function writeStoredEvent(agentId, ev) {
    const res = clients.get(agentId);
    if (!res)
        return false;
    if (!isWritable(res))
        return false;
    try {
        const payload = JSON.parse(ev.payload);
        payload._hub_event_id = ev.id;
        res.write(`id: ${ev.id}\n`);
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        touchActivity(agentId);
        return true;
    }
    catch (err) {
        logError("sse_replay_write_error", err, { module: "sse", agent_id: agentId, event_id: ev.id });
        return false;
    }
}
/**
 * 广播给多个 Agent
 */
export function broadcast(agentIds, event) {
    const results = {};
    for (const id of agentIds) {
        results[id] = pushToAgent(id, event);
    }
    return results;
}
/**
 * SSE 广播：推送给所有已连接 Agent（P1-4 激活态变更广播）
 */
export function broadcastToAll(event) {
    const results = {};
    for (const agentId of clients.keys()) {
        results[agentId] = pushToAgent(agentId, event);
    }
    return results;
}
/**
 * 查询哪些 Agent 在线
 */
export function onlineAgents() {
    return [...clients.keys()];
}
export function connectedCount() {
    return clients.size;
}
/**
 * Phase 5b: 优雅关闭时 drain 所有 SSE 连接
 * 向每个客户端发送 close 事件后关闭连接
 */
export function drainAllClients() {
    for (const [agentId, res] of clients.entries()) {
        try {
            const eventId = nextEventId(agentId);
            res.write(`id: ${eventId}\n`);
            res.write(`event: hub_shutdown\n`);
            res.write(`data: {"message":"Server shutting down"}\n\n`);
            res.end();
        }
        catch (err) {
            logger.debug("sse_drain_write_error", { module: "sse", agent_id: agentId });
        }
    }
    clients.clear();
    clientEventCounters.clear();
}
//# sourceMappingURL=sse.js.map