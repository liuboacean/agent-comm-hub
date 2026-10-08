/**
 * utils.ts — MCP 工具共享工具函数
 * 从 tools.ts 提取，供 src/tools/ 下所有模块共用
 */
import { type AuthContext } from "./security.js";
export declare function withRetry<T>(fn: () => T, label: string, maxRetries?: number): Promise<T>;
/**
 * 创建带权限检查的工具包装器
 */
export declare function requireAuth(authContext: AuthContext | undefined, toolName: string): AuthContext;
/**
 * 将 MCP 工具 handler 包装为自动认证版本。
 * 消除每个 handler 开头手动调用 requireAuth() 的重复模式。
 *
 * @param authContext  认证上下文（由 registerXxxTools 的闭包传入）
 * @param toolName     工具名称，用于权限检查
 * @param fn           实际的 handler 函数，接收已验证的 AuthContext + 工具参数
 */
export declare function authed<T extends Record<string, unknown>>(authContext: AuthContext | undefined, toolName: string, fn: (ctx: AuthContext, params: T) => ReturnType<typeof mcpFail> | Promise<ReturnType<typeof mcpFail>>): (params: T) => ReturnType<typeof mcpFail> | Promise<ReturnType<typeof mcpFail>>;
/** MCP 工具 catch 块返回的统一格式（兼容 MCP SDK Tool callback 返回类型） */
export interface McpErrorContent {
    content: [{
        type: "text";
        text: string;
    }];
    isError?: boolean;
    [x: string]: unknown;
}
/**
 * 构建统一 MCP 错误返回
 * HubError → 结构化 JSON（含 code）
 * 其他 Error → 简单 JSON（含 error + message）
 * unknown   → 简单 JSON（String(err)）
 */
export declare function mcpError(err: unknown, toolName?: string): McpErrorContent;
/**
 * 构建统一 MCP 验证失败返回（非异常，用于 result.ok === false）
 * 将 { success: false, error: string } 统一为 McpErrorContent
 */
export declare function mcpFail(error: string, toolName?: string): McpErrorContent;
