/**
 * tools/subscription.ts — P1 SSE 事件订阅工具（订阅直通）
 *
 * 仅暴露一个工具 subscribe_events，支持 subscribe / unsubscribe / list 三种动作。
 * 安全约束：只能管理「调用方自身」(ctx.agentId) 的订阅，杜绝越权订阅他人事件；
 * 退订时若 event_type 与 topic_filter 均为默认（'*'/空）则清空该 Agent 全部订阅。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthContext } from "../security.js";
/**
 * 注册 SSE 事件订阅工具
 */
export declare function registerSubscriptionTools(server: McpServer, authContext?: AuthContext): void;
