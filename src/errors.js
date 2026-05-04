/**
 * errors.ts — 统一错误码体系
 * Phase D: 替换散落的 new Error()，提供结构化错误信息
 */
// ─── 错误码枚举 ────────────────────────────────────────────
export var HubErrorCode;
(function (HubErrorCode) {
    // 通用 1xxx
    HubErrorCode["UNKNOWN"] = "HUB_1000";
    HubErrorCode["INTERNAL"] = "HUB_1001";
    HubErrorCode["NOT_FOUND"] = "HUB_1002";
    HubErrorCode["VALIDATION"] = "HUB_1003";
    HubErrorCode["ALREADY_EXISTS"] = "HUB_1004";
    HubErrorCode["UNREACHABLE"] = "HUB_1005";
    // 认证/权限 2xxx
    HubErrorCode["AUTH_REQUIRED"] = "HUB_2000";
    HubErrorCode["PERMISSION_DENIED"] = "HUB_2001";
    HubErrorCode["TOKEN_EXPIRED"] = "HUB_2002";
    HubErrorCode["TOKEN_INVALID"] = "HUB_2003";
    // Agent 3xxx
    HubErrorCode["AGENT_NOT_FOUND"] = "HUB_3000";
    HubErrorCode["AGENT_OFFLINE"] = "HUB_3001";
    HubErrorCode["INVALID_ROLE"] = "HUB_3002";
    // 任务/编排 4xxx
    HubErrorCode["TASK_NOT_FOUND"] = "HUB_4000";
    HubErrorCode["INVALID_TRANSITION"] = "HUB_4001";
    HubErrorCode["CYCLE_DETECTED"] = "HUB_4002";
    HubErrorCode["DEPENDENCY_EXISTS"] = "HUB_4003";
    HubErrorCode["DEPENDENCY_NOT_FOUND"] = "HUB_4004";
    HubErrorCode["HANDOFF_NOT_TARGET"] = "HUB_4005";
    HubErrorCode["GATE_NOT_FOUND"] = "HUB_4006";
    HubErrorCode["GATE_ALREADY_EVAL"] = "HUB_4007";
    HubErrorCode["PARALLEL_MIN_TASKS"] = "HUB_4008";
    HubErrorCode["PARALLEL_MAX_TASKS"] = "HUB_4009";
    HubErrorCode["GROUP_NOT_FOUND"] = "HUB_4010";
    // Pipeline 5xxx
    HubErrorCode["PIPELINE_NOT_FOUND"] = "HUB_5000";
    // 消息 6xxx
    HubErrorCode["MESSAGE_SEND_FAIL"] = "HUB_6000";
    // 数据库 7xxx
    HubErrorCode["DB_ERROR"] = "HUB_7000";
    HubErrorCode["DB_INTEGRITY"] = "HUB_7001";
})(HubErrorCode || (HubErrorCode = {}));
// ─── HubError 类 ────────────────────────────────────────────
export class HubError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "HubError";
        this.code = code;
        this.details = details;
    }
    /** 序列化为 MCP 工具返回格式 */
    toJSON() {
        return {
            error: true,
            code: this.code,
            message: this.message,
            ...(this.details && { details: this.details }),
        };
    }
    /** 从 unknown 判断是否为 HubError */
    static isHubError(err) {
        return err instanceof HubError;
    }
}
// ─── 工厂函数（简化常见错误创建） ────────────────────────────
export function notFound(resource, id) {
    return new HubError(HubErrorCode.NOT_FOUND, `${resource} not found: ${id}`, { resource, id });
}
export function alreadyExists(resource, id) {
    return new HubError(HubErrorCode.ALREADY_EXISTS, `${resource} already exists${id ? `: ${id}` : ""}`, { resource, id });
}
export function validation(msg, details) {
    return new HubError(HubErrorCode.VALIDATION, msg, details);
}
export function permissionDenied(tool, required, actual) {
    return new HubError(HubErrorCode.PERMISSION_DENIED, `Permission denied: ${tool} requires '${required}' role, current role is '${actual}'`, { tool, required, actual });
}
export function authRequired(tool) {
    return new HubError(HubErrorCode.AUTH_REQUIRED, tool ? `Authentication required for tool: ${tool}` : "Authentication required", { tool });
}
//# sourceMappingURL=errors.js.map