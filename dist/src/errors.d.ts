/**
 * errors.ts — 统一错误码体系
 * Phase D: 替换散落的 new Error()，提供结构化错误信息
 */
export declare enum HubErrorCode {
    UNKNOWN = "HUB_1000",
    INTERNAL = "HUB_1001",
    NOT_FOUND = "HUB_1002",
    VALIDATION = "HUB_1003",
    ALREADY_EXISTS = "HUB_1004",
    UNREACHABLE = "HUB_1005",
    AUTH_REQUIRED = "HUB_2000",
    PERMISSION_DENIED = "HUB_2001",
    TOKEN_EXPIRED = "HUB_2002",
    TOKEN_INVALID = "HUB_2003",
    AGENT_NOT_FOUND = "HUB_3000",
    AGENT_OFFLINE = "HUB_3001",
    INVALID_ROLE = "HUB_3002",
    TASK_NOT_FOUND = "HUB_4000",
    INVALID_TRANSITION = "HUB_4001",
    CYCLE_DETECTED = "HUB_4002",
    DEPENDENCY_EXISTS = "HUB_4003",
    DEPENDENCY_NOT_FOUND = "HUB_4004",
    HANDOFF_NOT_TARGET = "HUB_4005",
    GATE_NOT_FOUND = "HUB_4006",
    GATE_ALREADY_EVAL = "HUB_4007",
    PARALLEL_MIN_TASKS = "HUB_4008",
    PARALLEL_MAX_TASKS = "HUB_4009",
    GROUP_NOT_FOUND = "HUB_4010",
    PIPELINE_NOT_FOUND = "HUB_5000",
    MESSAGE_SEND_FAIL = "HUB_6000",
    DB_ERROR = "HUB_7000",
    DB_INTEGRITY = "HUB_7001"
}
export declare class HubError extends Error {
    readonly code: HubErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: HubErrorCode, message: string, details?: Record<string, unknown>);
    /** 序列化为 MCP 工具返回格式 */
    toJSON(): {
        error: true;
        code: string;
        message: string;
        details?: Record<string, unknown>;
    };
    /** 从 unknown 判断是否为 HubError */
    static isHubError(err: unknown): err is HubError;
}
export declare function notFound(resource: string, id: string): HubError;
export declare function alreadyExists(resource: string, id?: string): HubError;
export declare function validation(msg: string, details?: Record<string, unknown>): HubError;
export declare function permissionDenied(tool: string, required: string, actual: string): HubError;
export declare function authRequired(tool?: string): HubError;
