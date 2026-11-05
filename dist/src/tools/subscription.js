import { z } from "zod";
import { subscribeEvent, unsubscribeEvent, getSubscriptions, normalizeConditionJson, } from "../db.js";
import { reloadSubsCache } from "../sse.js";
import { authed, mcpFail } from "../utils.js";
/**
 * 注册 SSE 事件订阅工具
 */
export function registerSubscriptionTools(server, authContext) {
    server.tool("subscribe_events", "管理当前 Agent 的 SSE 事件订阅（订阅直通）。订阅后 Hub 在广播时按订阅规则剪枝，未订阅的 Agent 仍全投。仅可管理自身订阅。", {
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
            .describe("L1 主题子串过滤：对事件 payload JSON 做 includes；空 = 不限主题"),
        condition_json: z
            .string()
            .optional()
            .describe("P2-B L2 结构化条件 JSON 数组，如 [{\"path\":\"task.priority\",\"op\":\"eq\",\"value\":\"high\"}]；全部 AND 命中才投递。空/不传 = 仅 L1"),
    }, authed(authContext, "subscribe_events", async (ctx, { action, event_type, topic_filter, condition_json }) => {
        const agentId = ctx.agentId;
        const et = event_type && event_type.trim() ? event_type : "*";
        const tf = topic_filter && topic_filter.trim() ? topic_filter : "";
        // 校验 + 规范化 L2 条件；非法一律拒绝，不静默放宽（fail-closed）。
        let cj = "";
        if (condition_json !== undefined) {
            try {
                cj = normalizeConditionJson(condition_json);
            }
            catch (err) {
                return mcpFail(err instanceof Error ? err.message : String(err), "subscribe_events");
            }
        }
        if (action === "subscribe") {
            subscribeEvent(agentId, et, tf, cj);
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
                            condition_json: cj,
                            subscriptions: getSubscriptions(agentId),
                        }),
                    },
                ],
            };
        }
        if (action === "unsubscribe") {
            // 未传 condition_json → 旧三元组/清空全部语义；显式传（含空串）→ 四元组精确退订。
            const removed = unsubscribeEvent(agentId, et, tf, condition_json === undefined ? undefined : cj);
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
        const subs = getSubscriptions(agentId);
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
    }));
}
//# sourceMappingURL=subscription.js.map