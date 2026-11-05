/**
 * tools/subscription.ts — P1 SSE 事件订阅工具（订阅直通）
 *
 * 仅暴露一个工具 subscribe_events，支持 subscribe / unsubscribe / list 三种动作。
 * 安全约束：只能管理「调用方自身」(ctx.agentId) 的订阅，杜绝越权订阅他人事件；
 * 退订时若 event_type 与 topic_filter 均为默认（'*'/空）且未指定 condition_json，则清空该 Agent 全部订阅。
 * P2-B：新增可选 condition_json（L2 结构化条件 JSON 数组），服务端严格校验后规范化；
 * 非法条件一律拒绝（fail-closed），不静默放宽。condition_json 为空 = 仅 L1，保持 P1 语义。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthContext } from "../security.js";
/**
 * 注册 SSE 事件订阅工具
 */
export declare function registerSubscriptionTools(server: McpServer, authContext?: AuthContext): void;
