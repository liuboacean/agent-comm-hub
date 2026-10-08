/**
 * authorization.ts — 操作级人在环授权服务（Feature B / Hub 侧）
 *
 * 职责：
 *   - 建请求（createRequest）：写 auth_requests(pending) + 推 authorization_requested
 *   - 决议（resolve）：approved/rejected/expired + 可选信任窗口(auth_grants) + 推 authorization_resolved
 *   - 过期清扫（sweepExpired）：周期扫描 TTL 过期请求 → expired + 推 authorization_resolved(expired)
 *   - 信任窗口（auth_grants）：类目级时间窗口信任，由人类在批准时显式授予
 *
 * 所有决议/过期均 auditLog 锚定进既有哈希链（不新增审计表）。
 * 零新增依赖，全部复用 better-sqlite3 / sse / security。
 */
import { db } from "./db.js";
import { pushToAgent } from "./sse.js";
import { auditLog } from "./security.js";
// ⚠️ 与 client-sdk/types.ts 的 AUTH_OP_TYPES 必须保持一致（Hub 不依赖 client-sdk）
export const AUTH_OP_TYPES = [
    "delete_data",
    "cancel_task",
    "revoke_token",
    "cross_agent_delete",
    "send_external_email",
    "external_api",
    "paid_api",
    "schema_change",
];
// ─── 配置（与设计文档 §8.5 默认值对齐；server.ts 同样文档化这些值）──
const AUTH_REQUEST_TTL_MS = parseInt(process.env.AUTH_REQUEST_TTL_MS ?? "600000", 10); // 默认 10min
const AUTH_AUTO_APPROVE = process.env.AUTH_AUTO_APPROVE === "true"; // 默认关闭（deny-by-default）
class AuthorizationService {
    /** 请求敏感操作的授权，返回新建的 pending 请求（含 request_id） */
    createRequest(agentId, op) {
        const id = `req_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const now = Date.now();
        const expiresAt = now + AUTH_REQUEST_TTL_MS;
        const opPayload = op.payload === undefined
            ? null
            : typeof op.payload === "string"
                ? op.payload
                : JSON.stringify(op.payload);
        db.prepare(`INSERT INTO auth_requests
        (id, agent_id, task_id, op_type, op_payload, status, created_at, expires_at)
       VALUES (@id, @agent_id, @task_id, @op_type, @op_payload, 'pending', @created_at, @expires_at)`).run({
            id,
            agent_id: agentId,
            task_id: op.taskId ?? null,
            op_type: op.type,
            op_payload: opPayload,
            created_at: now,
            expires_at: expiresAt,
        });
        // 审计：建请求锚定进哈希链
        auditLog("auth_request", agentId, id, op.type);
        // 透明记录：推 authorization_requested（仪表盘轮询亦可看到）
        pushToAgent(agentId, {
            event: "authorization_requested",
            request: {
                id,
                agent_id: agentId,
                task_id: op.taskId,
                op_type: op.type,
                op_payload: opPayload ?? undefined,
                status: "pending",
                created_at: now,
                expires_at: expiresAt,
            },
        });
        // 可选快路径：开启自动批准且存在有效信任窗口 → 直接 approved
        if (AUTH_AUTO_APPROVE && this.hasValidGrant(agentId, op.type)) {
            return this.resolve(id, "approved", "system", "auto-approve via valid grant");
        }
        return this.getById(id);
    }
    /** 决议一个 pending 请求；返回决议后的行 */
    resolve(reqId, decision, by, reason, grantWindowMs) {
        const row = this.getById(reqId);
        if (!row)
            throw new Error(`授权请求不存在: ${reqId}`);
        if (row.status !== "pending") {
            throw new Error(`授权请求已被决议(${row.status})，无法重复决议: ${reqId}`);
        }
        const now = Date.now();
        db.prepare(`UPDATE auth_requests
       SET status=?, resolved_by=?, resolved_at=?, decision_reason=?
       WHERE id=?`).run(decision, by, now, reason ?? null, reqId);
        // 审计：决议锚定进哈希链
        auditLog("auth_resolve", by, reqId, `${decision}|${reason ?? ""}`);
        // 可选：批准时建立信任窗口（决策 3 高级项）
        if (decision === "approved" && grantWindowMs && grantWindowMs > 0) {
            this.createGrant(row.agent_id, row.op_type, by, grantWindowMs);
        }
        // 回推请求方 Agent，解锁其 Promise
        pushToAgent(row.agent_id, {
            event: "authorization_resolved",
            request_id: reqId,
            agent_id: row.agent_id,
            task_id: row.task_id ?? undefined,
            decision,
            reason,
        });
        return this.getById(reqId);
    }
    /** 列出授权请求（可按状态过滤） */
    list(status) {
        if (status) {
            return db
                .prepare(`SELECT * FROM auth_requests WHERE status=? ORDER BY created_at DESC`)
                .all(status);
        }
        return db
            .prepare(`SELECT * FROM auth_requests ORDER BY created_at DESC`)
            .all();
    }
    /**
     * 周期清扫：扫描 expires_at < now 且 status=pending 的请求，
     * 标记为 expired + 审计 + 回推 authorization_resolved(expired) 解锁 Agent Promise。
     * @returns 被清扫（过期）的请求数量
     */
    sweepExpired() {
        const now = Date.now();
        const pending = db
            .prepare(`SELECT * FROM auth_requests WHERE status='pending' AND expires_at < ?`)
            .all(now);
        let count = 0;
        for (const row of pending) {
            db.prepare(`UPDATE auth_requests SET status='expired' WHERE id=?`).run(row.id);
            auditLog("auth_expire", "system", row.id, row.op_type);
            pushToAgent(row.agent_id, {
                event: "authorization_resolved",
                request_id: row.id,
                agent_id: row.agent_id,
                task_id: row.task_id ?? undefined,
                decision: "expired",
            });
            count++;
        }
        return count;
    }
    /** 是否存在对该 Agent + 操作类目仍有效的信任窗口 */
    hasValidGrant(agentId, opCategory) {
        const now = Date.now();
        const row = db
            .prepare(`SELECT id FROM auth_grants
         WHERE agent_id=? AND op_category=? AND expires_at > ?
         LIMIT 1`)
            .get(agentId, opCategory, now);
        return !!row;
    }
    /** 建立信任窗口（类目级时间窗口信任） */
    createGrant(agentId, opCategory, by, grantWindowMs) {
        const id = `grant_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const now = Date.now();
        const expiresAt = now + grantWindowMs;
        db.prepare(`INSERT INTO auth_grants (id, agent_id, op_category, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`).run(id, agentId, opCategory, by, now, expiresAt);
        auditLog("auth_grant", by, id, `${agentId}:${opCategory}:${grantWindowMs}ms`);
        return {
            id,
            agent_id: agentId,
            op_category: opCategory,
            granted_by: by,
            granted_at: now,
            expires_at: expiresAt,
        };
    }
    getById(id) {
        return db.prepare(`SELECT * FROM auth_requests WHERE id=?`).get(id);
    }
}
export const authorizationService = new AuthorizationService();
export { AUTH_REQUEST_TTL_MS, AUTH_AUTO_APPROVE };
//# sourceMappingURL=authorization.js.map