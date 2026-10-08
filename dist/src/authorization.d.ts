export declare const AUTH_OP_TYPES: readonly ["delete_data", "cancel_task", "revoke_token", "cross_agent_delete", "send_external_email", "external_api", "paid_api", "schema_change"];
export type AuthStatus = "pending" | "approved" | "rejected" | "expired";
/** 提交授权请求时的入参 */
export interface CreateAuthOp {
    type: string;
    description: string;
    payload?: string | unknown;
    taskId?: string;
}
export interface AuthRequestRow {
    id: string;
    agent_id: string;
    task_id: string | null;
    op_type: string;
    op_payload: string | null;
    status: AuthStatus;
    created_at: number;
    expires_at: number;
    resolved_by: string | null;
    resolved_at: number | null;
    decision_reason: string | null;
}
export interface AuthGrantRow {
    id: string;
    agent_id: string;
    op_category: string;
    granted_by: string;
    granted_at: number;
    expires_at: number;
}
declare const AUTH_REQUEST_TTL_MS: number;
declare const AUTH_AUTO_APPROVE: boolean;
declare class AuthorizationService {
    /** 请求敏感操作的授权，返回新建的 pending 请求（含 request_id） */
    createRequest(agentId: string, op: CreateAuthOp): AuthRequestRow;
    /** 决议一个 pending 请求；返回决议后的行 */
    resolve(reqId: string, decision: "approved" | "rejected", by: string, reason?: string, grantWindowMs?: number): AuthRequestRow;
    /** 列出授权请求（可按状态过滤） */
    list(status?: AuthStatus): AuthRequestRow[];
    /**
     * 周期清扫：扫描 expires_at < now 且 status=pending 的请求，
     * 标记为 expired + 审计 + 回推 authorization_resolved(expired) 解锁 Agent Promise。
     * @returns 被清扫（过期）的请求数量
     */
    sweepExpired(): number;
    /** 是否存在对该 Agent + 操作类目仍有效的信任窗口 */
    hasValidGrant(agentId: string, opCategory: string): boolean;
    /** 建立信任窗口（类目级时间窗口信任） */
    createGrant(agentId: string, opCategory: string, by: string, grantWindowMs: number): AuthGrantRow;
    private getById;
}
export declare const authorizationService: AuthorizationService;
export { AUTH_REQUEST_TTL_MS, AUTH_AUTO_APPROVE };
