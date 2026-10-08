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
//# sourceMappingURL=types.js.map