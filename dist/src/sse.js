import { logger, logError } from "./logger.js";
import { eventLogRepo } from "./repo/event-log.js";
import { getAllSubscriptions, subscriptionMatches } from "./db.js";
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
    // 清理该 Agent 的待发缓冲与定时器（断线后投递无意义，事件仍留 event_log 待重连补发）
    deliveryBuffers.delete(agentId);
    const pendingTimer = deliveryTimers.get(agentId);
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        deliveryTimers.delete(agentId);
    }
    logger.info("sse_client_disconnected", { module: "sse", agent_id: agentId, total: clients.size });
}
/** 连接是否仍可写（P2-5 修复：防 write-after-end 噪声） */
function isWritable(res) {
    return !res.writableEnded && !res.destroyed && res.writable;
}
// ─── P1: SSE 事件批处理（突发合并，降低实时写开销） ───────
// 仅作用于「本进程持有 SSE 连接的实时投递路径」（clients.has 命中）。
// 桥接转发（SSE_BRIDGE_URL）与重连补发（writeStoredEvent）保持立即投递 + 至少一次语义。
// 每条事件仍先落 event_log 取全局 seq（保证去重/补发），仅把「网络写入」做窗口合并。
const deliveryBuffers = new Map();
const deliveryTimers = new Map();
// 在【调用时】读取环境变量（非模块加载时），便于运行时调整与测试覆盖。
// HUB_SSE_BATCH_MS 默认 0 = 关闭批处理（逐条立即投递，D1 严格同步可靠性契约默认路径）；
// 设为 >0（如 120）才启用窗口合并优化（opt-in）。HUB_SSE_BATCH_MAX=25 单 Agent 缓冲上限，达到即立即冲刷。
function batchWindowMs() {
    return Math.max(0, Number(process.env.HUB_SSE_BATCH_MS ?? 0));
}
function batchMaxSize() {
    return Math.max(1, Number(process.env.HUB_SSE_BATCH_MAX ?? 25));
}
/**
 * 将一条已持久化（已取得 seq）的事件入队，等待窗口到期或达上限后批量落网。
 * @returns true = 已入队（事件已落库，至少一次）；false = 立即投递失败
 */
function enqueueForDelivery(agentId, event, dedupId, seq) {
    const BATCH_MS = batchWindowMs();
    const BATCH_MAX = batchMaxSize();
    // 批处理关闭：保持旧行为，立即投递
    if (BATCH_MS <= 0) {
        const ok = deliverToLocalClient(agentId, event, dedupId, seq);
        if (ok)
            eventLogRepo.markDelivered(seq);
        return ok;
    }
    let buf = deliveryBuffers.get(agentId);
    if (!buf) {
        buf = [];
        deliveryBuffers.set(agentId, buf);
    }
    buf.push({ event, dedupId, seq });
    // 达上限：立即冲刷（避免单 Agent 突发撑爆内存 / 延迟过高）
    if (buf.length >= BATCH_MAX) {
        flushAgentBuffer(agentId);
        return true;
    }
    if (!deliveryTimers.has(agentId)) {
        const timer = setTimeout(() => {
            deliveryTimers.delete(agentId);
            flushAgentBuffer(agentId);
        }, BATCH_MS);
        deliveryTimers.set(agentId, timer);
    }
    return true;
}
/**
 * 冲刷某 Agent 的缓冲：按序逐条投递（每条仍独立成 SSE 消息，保留协议/去重不变），
 * 成功写入即标记 delivered；失败不标记，依赖重连 replay 兜底。
 */
function flushAgentBuffer(agentId) {
    const timer = deliveryTimers.get(agentId);
    if (timer) {
        clearTimeout(timer);
        deliveryTimers.delete(agentId);
    }
    const buf = deliveryBuffers.get(agentId);
    if (!buf || buf.length === 0) {
        deliveryBuffers.delete(agentId);
        return;
    }
    deliveryBuffers.delete(agentId);
    for (const d of buf) {
        const ok = deliverToLocalClient(agentId, d.event, d.dedupId, d.seq);
        if (ok)
            eventLogRepo.markDelivered(d.seq);
        // 失败：不标记 delivered，重连 replay 会补发（至少一次）
    }
}
/** 冲刷全部缓冲（优雅关闭时调用，尽量把待发事件推出去） */
function flushAllBuffers() {
    for (const agentId of deliveryBuffers.keys()) {
        flushAgentBuffer(agentId);
    }
}
// ─── P1: 订阅缓存（SSE 事件订阅剪枝） ─────────────────
// 仅「有订阅」的 Agent 进入缓存；未订阅 Agent 不进入，broadcastToAll 维持全投（零回归）。
let subsCache = new Map();
/**
 * 重新从 DB 加载订阅规则到内存缓存。
 * 订阅变更（subscribe_events 工具）与进程启动后均应调用。
 */
export function reloadSubsCache() {
    const all = getAllSubscriptions();
    const map = new Map();
    for (const s of all) {
        const arr = map.get(s.agent_id);
        if (arr)
            arr.push(s);
        else
            map.set(s.agent_id, [s]);
    }
    subsCache = map;
    logger.info("sse_subs_cache_reloaded", { module: "sse", agents: map.size, rules: all.length });
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
    // 2a. 本地命中：本进程持有该 Agent 的 SSE 连接 → 入队批量投递（以全局 seq 作为 SSE id）
    if (clients.has(agentId)) {
        return enqueueForDelivery(agentId, event, dedupId, seq);
    }
    // 2b. 跨进程桥接（方案 B）：本进程无该 Agent 的 SSE 连接。
    //     典型场景：stdio MCP 进程派单，而 SSE 长连接挂在 HTTP 服务进程。
    //     事件已落库，转发到桥接地址由其本地投递；失败则靠重连 replay 兜底（至少一次）。
    const bridgeUrl = process.env.SSE_BRIDGE_URL;
    if (bridgeUrl) {
        void forwardToBridge(bridgeUrl, agentId, event, dedupId, seq);
        return true; // 已派发至桥接进程（乐观：事件已持久化，至少一次投递）
    }
    // 2c. 离线且未配置桥接：事件已持久化，等待首连 / 重连补发
    return false;
}
/**
 * 仅向「本地」SSE 连接投递（不落库、不生成 seq）。
 * - pushToAgent 本地命中路径复用
 * - 跨进程桥接端点 /internal/sse/push 复用（避免事件在 event_log 重复写入）
 * @param eventId 可选 SSE id，跨进程场景传全局 seq，保证与重连 replay 一致
 * @returns true = 命中本地连接且成功写入
 */
export function deliverToLocalClient(agentId, event, dedupId, eventId) {
    const res = clients.get(agentId);
    if (!res)
        return false;
    if (!isWritable(res)) {
        removeClient(agentId);
        return false;
    }
    const payload = {
        ...event,
        ...(dedupId ? { _hub_dedup_id: dedupId } : {}),
    };
    const id = eventId ?? nextEventId(agentId);
    try {
        payload._hub_event_id = id;
        res.write(`id: ${id}\n`);
        res.write(`event: message\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        touchActivity(agentId);
        return true;
    }
    catch (err) {
        removeClient(agentId);
        return false;
    }
}
/**
 * 跨进程桥接转发（方案 B）：把事件 POST 到桥接进程的 /internal/sse/push，
 * 由其本地投递到持有 SSE 连接的 Agent。fire-and-forget（pushToAgent 保持同步）。
 */
async function forwardToBridge(bridgeUrl, agentId, event, dedupId, seq) {
    const url = `${bridgeUrl.replace(/\/$/, "")}/internal/sse/push`;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.HUB_AUTH_TOKEN ?? ""}`,
            },
            body: JSON.stringify({ agentId, event, dedupId, seq }),
        });
        if (!resp.ok) {
            logError("sse_bridge_forward_failed", new Error(`HTTP ${resp.status}`), {
                module: "sse", agent_id: agentId, bridge: bridgeUrl,
            });
            return;
        }
        const data = (await resp.json().catch(() => ({})));
        if (!data.delivered) {
            logger.warn("sse_bridge_not_delivered", { module: "sse", agent_id: agentId, bridge: bridgeUrl });
        }
    }
    catch (err) {
        logError("sse_bridge_forward_error", err, { module: "sse", agent_id: agentId, bridge: bridgeUrl });
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
 *
 * P1 订阅剪枝：仅当 Agent 已声明订阅且其订阅规则**未命中**本次事件时才跳过；
 * 未订阅（缓存中无该 Agent）的 Agent 维持现状全投，零回归。
 * P2-B 两级过滤：把事件对象一并交给 subscriptionMatches，让 L2 结构化条件按字段求值；
 * condition_json 为空的旧订阅走纯 L1 路径，行为不变。
 * 注意：剪枝只在「实时广播」生效；点对点 pushToAgent 不受影响（仍按收件人精确投递）。
 */
export function broadcastToAll(event) {
    const results = {};
    const eventType = String(event.event ?? "event");
    const payloadStr = JSON.stringify(event);
    const eventObj = event;
    for (const agentId of clients.keys()) {
        const subs = subsCache.get(agentId);
        if (subs && !subscriptionMatches(eventType, payloadStr, subs, eventObj)) {
            results[agentId] = false; // 订阅剪枝：不投递
            continue;
        }
        results[agentId] = pushToAgent(agentId, event);
    }
    return results;
}
/**
 * 查询哪些 Agent 在线（仅看 SSE 实时连接）
 */
export function onlineAgents() {
    return [...clients.keys()];
}
/**
 * 判断指定 Agent 当前是否有活跃的 SSE 实时连接。
 * 用于「在线状态」统一判定：有 SSE 连接即视为可达（可实时派单）。
 */
export function isAgentConnected(agentId) {
    return clients.has(agentId);
}
export function connectedCount() {
    return clients.size;
}
/**
 * Phase 5b: 优雅关闭时 drain 所有 SSE 连接
 * 向每个客户端发送 close 事件后关闭连接
 */
export function drainAllClients() {
    // 先冲刷所有待发缓冲，把缓冲中的事件尽可能推出去，再发关闭信号
    flushAllBuffers();
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