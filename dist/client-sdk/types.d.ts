/**
 * types.ts — 客户端 SDK 共享类型与常量
 *
 * ⚠️ 与 Hub 侧 `src/authorization.ts` 中的 AUTH_OP_TYPES 必须保持一致。
 * 两套定义各自独立（Hub 不依赖 client-sdk，反之亦然），修改时务必同步两侧。
 */
/**
 * 需要人类在环授权的敏感操作类目。
 * 默认进授权队列：delete_data / cancel_task / revoke_token / cross_agent_delete /
 * send_external_email / external_api / paid_api / schema_change。
 */
export declare const AUTH_OP_TYPES: readonly ["delete_data", "cancel_task", "revoke_token", "cross_agent_delete", "send_external_email", "external_api", "paid_api", "schema_change"];
export type AuthOpType = (typeof AUTH_OP_TYPES)[number];
/**
 * 授权状态枚举（Hub 与 SDK 必须一致）。
 * pending | approved | rejected | expired
 */
export type AuthStatus = "pending" | "approved" | "rejected" | "expired";
/**
 * 敏感操作描述（宿主 execute() 内传给 requestAuthorization）。
 * type 为 AUTH_OP_TYPES 之一；description 是人类可读的“将要做什么”；
 * payload 是供人类判定的具体参数（JSON 序列化后入库）。
 */
export interface SensitiveOp {
    type: string;
    description: string;
    payload?: unknown;
    taskId?: string;
}
/** 授权请求（SDK 侧 requestAuthorization 返回结构中的 request_id 来源） */
export interface AuthRequest {
    id: string;
    agent_id: string;
    task_id?: string;
    op_type: string;
    op_payload?: unknown;
    status: AuthStatus;
    created_at: number;
    expires_at: number;
}
