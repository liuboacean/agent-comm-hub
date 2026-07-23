/**
 * repo/event-log.ts — 持久化 SSE 事件日志（D1 修复核心）
 *
 * 维护一张全局事件日志 event_log，每条出站事件带**全局单调**的
 * event_seq（AUTOINCREMENT），用于：
 *   - 断线重连时按 seq 精确补发（id > Last-Event-ID），覆盖所有事件类型
 *   - 首连时补发未投递（delivered=0）的事件
 *
 * 与消息表（messages）解耦：这里记录的是「推送给某 Agent 的事件流」，
 * 不依赖具体业务表，因此能覆盖 new_message / task_assigned / agent_state_changed
 * 等全部事件类型。
 */
import { db } from "../db.js";
class EventLogRepo {
    /**
     * 追加一条事件到持久化日志，返回全局单调 seq（即 SSE 的 id）
     */
    appendEvent(agentId, eventType, payload) {
        const info = db
            .prepare(`INSERT INTO event_log (agent_id, event_type, payload, delivered, created_at)
         VALUES (?, ?, ?, 0, ?)`)
            .run(agentId, eventType, payload, Date.now());
        return Number(info.lastInsertRowid);
    }
    /**
     * 取出 seq 之后（不含 seq）该 Agent 的全部事件，按 seq 升序。
     * 用于断线重连的精确补发（覆盖所有事件类型）。
     */
    getEventsAfter(seq, agentId, limit = 1000) {
        return db
            .prepare(`SELECT * FROM event_log WHERE agent_id=? AND id > ? ORDER BY id ASC LIMIT ?`)
            .all(agentId, seq, limit);
    }
    /**
     * 取出该 Agent 尚未投递（delivered=0）的事件，按 seq 升序。
     * 用于首连补发（agent 离线期间累积的事件）。
     */
    getUndelivered(agentId, limit = 1000) {
        return db
            .prepare(`SELECT * FROM event_log WHERE agent_id=? AND delivered=0 ORDER BY id ASC LIMIT ?`)
            .all(agentId, limit);
    }
    /** 标记某条事件已成功投递（仅成功推送才标记，见 D1） */
    markDelivered(seq) {
        db.prepare(`UPDATE event_log SET delivered=1 WHERE id=?`).run(seq);
    }
}
export const eventLogRepo = new EventLogRepo();
//# sourceMappingURL=event-log.js.map