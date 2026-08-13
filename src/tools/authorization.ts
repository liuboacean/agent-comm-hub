/**
 * authorization.ts — Feature B 的 MCP 工具注册
 * Tools:
 *   - request_authorization      (member)：Agent 提交敏感操作授权请求
 *   - resolve_authorization      (admin) ：人类/管理员决议（主路径为仪表盘 REST）
 *   - list_authorization_requests(member)：列出授权请求（调试/仪表盘用）
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizationService, AUTH_OP_TYPES, type AuthStatus } from "../authorization.js";
import { requireAdmin, type AuthContext } from "../security.js";
import { authed, mcpError, mcpFail } from "../utils.js";

/**
 * 注册授权相关工具
 */
export function registerAuthorizationTools(server: McpServer, authContext?: AuthContext): void {
  // ────────────────────────────────────────────────────
  // request_authorization — member 可调用
  // Agent 在执行敏感操作前提交授权请求，Hub 建 pending 并推 authorization_requested
  // ────────────────────────────────────────────────────
  server.tool(
    "request_authorization",
    "提交一次操作级授权请求（人在环）。用于 delete_data / cancel_task / revoke_token / cross_agent_delete / send_external_email / external_api / paid_api / schema_change 等敏感操作。默认创建 pending 请求并推送仪表盘等待人类批准；批准后经 SSE 回推解锁。已认证 Agent（member 及以上）可调用。",
    {
      op_type: z.enum(AUTH_OP_TYPES).describe("操作类目"),
      description: z.string().describe("人类可读的操作说明"),
      op_payload: z.string().optional().describe("具体操作参数（JSON 字符串），供人类判定"),
      task_id: z.string().optional().describe("关联任务 ID（可选）"),
    },
    authed(authContext, "request_authorization", async (ctx, { op_type, description, op_payload, task_id }) => {
      try {
        const req = authorizationService.createRequest(ctx.agentId, {
          type: op_type,
          description,
          payload: op_payload,
          taskId: task_id,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              request_id: req.id,
              status: req.status,
              expires_at: req.expires_at,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        return mcpError(err, "request_authorization");
      }
    })
  );

  // ────────────────────────────────────────────────────
  // resolve_authorization — admin only（MCP 可选路径；主路径为仪表盘 REST）
  // ────────────────────────────────────────────────────
  server.tool(
    "resolve_authorization",
    "决议一个授权请求。approved=放行并解锁 Agent Promise；rejected=拒绝（Agent 优雅中止）。grant_window_ms 仅在批准时建立类目级信任窗口。仅 admin 可调用（主决议路径为仪表盘 REST 端点）。",
    {
      request_id: z.string().describe("授权请求 ID"),
      decision: z.enum(["approved", "rejected"]).describe("决议"),
      reason: z.string().optional().describe("决议理由（被拒时建议填写）"),
      grant_window_ms: z.number().int().positive().optional()
        .describe("批准时建立的信任窗口时长（ms），过期后仍需重新授权"),
    },
    authed(authContext, "resolve_authorization", async (ctx, { request_id, decision, reason, grant_window_ms }) => {
      requireAdmin(ctx); // 决议是敏感动作，仅 admin
      try {
        const req = authorizationService.resolve(
          request_id,
          decision,
          ctx.agentId,
          reason,
          grant_window_ms
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              request_id: req.id,
              status: req.status,
              decision: req.status === "approved" ? "approved" : "rejected",
              resolved_by: req.resolved_by,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        return mcpError(err, "resolve_authorization");
      }
    })
  );

  // ────────────────────────────────────────────────────
  // list_authorization_requests — member 可调用（调试/仪表盘）
  // ────────────────────────────────────────────────────
  server.tool(
    "list_authorization_requests",
    "列出授权请求。可传 status 过滤（pending|approved|rejected|expired）。供仪表盘或调试使用。已认证 Agent 可调用。",
    {
      status: z.enum(["pending", "approved", "rejected", "expired"] as const).optional()
        .describe("状态过滤"),
    },
    authed(authContext, "list_authorization_requests", async (_ctx, { status }) => {
      try {
        const requests = authorizationService.list(status as AuthStatus | undefined);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ requests, count: requests.length }, null, 2),
          }],
        };
      } catch (err: unknown) {
        return mcpError(err, "list_authorization_requests");
      }
    })
  );
}
