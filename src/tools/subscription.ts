/**
 * tools/subscription.ts — P1 SSE 事件订阅工具（订阅直通）
 *
 * 仅暴露一个工具 subscribe_events，支持 subscribe / unsubscribe / list 三种动作。
 * 安全约束：只能管理「调用方自身」(ctx.agentId) 的订阅，杜绝越权订阅他人事件；
 * 退订时若 event_type 与 topic_filter 均为默认（'*'/空）则清空该 Agent 全部订阅。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AuthContext } from "../security.js";
import {
  subscribeEvent,
  unsubscribeEvent,
  getSubscriptions,
  type Subscription,
} from "../db.js";
import { reloadSubsCache } from "../sse.js";
import { authed } from "../utils.js";

/**
 * 注册 SSE 事件订阅工具
 */
export function registerSubscriptionTools(server: McpServer, authContext?: AuthContext): void {
  server.tool(
    "subscribe_events",
    "管理当前 Agent 的 SSE 事件订阅（订阅直通）。订阅后 Hub 在广播时按订阅规则剪枝，未订阅的 Agent 仍全投。仅可管理自身订阅。",
    {
      action: z
        .enum(["subscribe", "unsubscribe", "list"])
        .describe("操作类型：subscribe=订阅；unsubscribe=退订（默认参数则清空全部订阅）；list=列出当前订阅"),
      event_type: z
        .string()
        .optional()
        .default("*")
        .describe("事件类型：'*' 或空 = 订阅全部；如 'message'/'task_assigned'/'activation_changed'"),
      topic_filter: z
        .string()
        .optional()
        .default("")
        .describe("主题子串过滤：对事件 payload JSON 做 includes；空 = 不限主题"),
    },
    authed(authContext, "subscribe_events", async (ctx, { action, event_type, topic_filter }) => {
      const agentId = ctx.agentId;
      const et = event_type && event_type.trim() ? event_type : "*";
      const tf = topic_filter && topic_filter.trim() ? topic_filter : "";

      if (action === "subscribe") {
        subscribeEvent(agentId, et, tf);
        reloadSubsCache();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                action: "subscribe",
                agent_id: agentId,
                event_type: et,
                topic_filter: tf,
                subscriptions: getSubscriptions(agentId),
              }),
            },
          ],
        };
      }

      if (action === "unsubscribe") {
        const removed = unsubscribeEvent(agentId, et, tf);
        reloadSubsCache();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                action: "unsubscribe",
                agent_id: agentId,
                event_type: et,
                topic_filter: tf,
                removed,
                subscriptions: getSubscriptions(agentId),
              }),
            },
          ],
        };
      }

      // list
      const subs: Subscription[] = getSubscriptions(agentId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: "list",
              agent_id: agentId,
              count: subs.length,
              subscriptions: subs,
            }),
          },
        ],
      };
    })
  );
}
