/**
 * authorization.ts — Feature B 的 MCP 工具注册
 * Tools:
 *   - request_authorization      (member)：Agent 提交敏感操作授权请求
 *   - resolve_authorization      (admin) ：人类/管理员决议（主路径为仪表盘 REST）
 *   - list_authorization_requests(member)：列出授权请求（调试/仪表盘用）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthContext } from "../security.js";
/**
 * 注册授权相关工具
 */
export declare function registerAuthorizationTools(server: McpServer, authContext?: AuthContext): void;
