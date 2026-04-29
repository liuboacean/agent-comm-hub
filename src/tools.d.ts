/**
 * tools.ts — MCP 工具定义 (Phase 1)
 * 原有 9 个工具 + 新增 4 个工具（register_agent/heartbeat/query_agents/revoke_token）
 * 全部工具注册到 McpServer，带 authContext 权限检查
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthContext } from "./security.js";
/**
 * 注册所有 MCP 工具
 * @param server McpServer 实例
 * @param authContext 认证上下文（未认证时为 undefined）
 */
export declare function registerTools(server: McpServer, authContext?: AuthContext): void;
