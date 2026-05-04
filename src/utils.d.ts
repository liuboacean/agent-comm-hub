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
