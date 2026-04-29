/**
 * tools.ts — MCP 工具定义 (Phase 1)
 * 原有 9 个工具 + 新增 4 个工具（register_agent/heartbeat/query_agents/revoke_token）
 * 全部工具注册到 McpServer，带 authContext 权限检查
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { type Message, type Task, type ConsumedEntry, db } from "./db.js";
import { messageRepo, taskRepo, consumedRepo } from "./repo/sqlite-impl.js";
import { pushToAgent, onlineAgents } from "./sse.js";
import {
  checkPermission,
  getRequiredPermission,
  auditLog,
  revokeToken as revokeTokenFromSecurity,
  recalculateTrustScore,
  recalculateAllTrustScores,
  type AuthContext,
} from "./security.js";
import {
  registerAgent as registerAgentFromIdentity,
  heartbeat as heartbeatFromIdentity,
  queryAgents as queryAgentsFromIdentity,
  clearOfflineNotification,
  getAgentTrustScore,
  updateAgentTrustScore,
  setAgentRole as setAgentRoleFromIdentity,
} from "./identity.js";
import { dedupMessage, validateMessageBody } from "./dedup.js";
import {
  storeMemory as storeMemoryFromService,
  recallMemory,
  listMemories,
  deleteMemory as deleteMemoryFromService,
  getMemoryStats,
} from "./memory.js";
import {
  shareExperience,
  proposeStrategy,
  proposeStrategyTiered,
  listStrategies,
  searchStrategies,
  applyStrategy,
  feedbackStrategy,
  approveStrategy,
  getEvolutionStatus,
  checkVetoWindow,
  vetoStrategy as vetoStrategyFromEvolution,
} from "./evolution.js";
import {
  addDependency as addDep,
  removeDependency as removeDep,
  getDependencies as getDeps,
  checkDependenciesSatisfied as checkDepsSatisfied,
  createParallelGroup,
  requestHandoff,
  acceptHandoff,
  rejectHandoff,
  addQualityGate as addQGate,
  evaluateQualityGate as evalQGate,
  createPipeline,
  getPipelineStatus,
  addTaskToPipeline,
} from "./orchestrator.js";
import { logError } from "./logger.js";
import { incrementMcpCall } from "./metrics.js";

// ─── 通用工具：带指数退避的重试 ──────────────────────────
async function withRetry<T>(
  fn: () => T,
  label: string,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      const isLast = attempt === maxRetries;
      logError("withRetry_failed", err, { label, attempt, maxRetries });
      if (isLast) throw err;
      const delay = Math.pow(2, attempt - 1) * 100;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`unreachable`);
}

/**
 * 创建带权限检查的工具包装器
 */
function requireAuth(
  authContext: AuthContext | undefined,
  toolName: string
): AuthContext {
  if (!authContext) {
    throw new Error(`Authentication required for tool: ${toolName}`);
  }
  if (!checkPermission(toolName, authContext.role)) {
    const required = getRequiredPermission(toolName) ?? "member";
    throw new Error(
      `Permission denied: ${toolName} requires '${required}' role, current role is '${authContext.role}'`
    );
  }
  return authContext;
}

/**
 * 注册所有 MCP 工具
 * @param server McpServer 实例
 * @param authContext 认证上下文（未认证时为 undefined）
 */
export function registerTools(server: McpServer, authContext?: AuthContext): void {

  // ────────────────────────────────────────────────────
  // NEW Tool 1: register_agent (Phase 1)
  // 注册新 Agent — public 工具，无需认证
  // ────────────────────────────────────────────────────
  server.tool(
    "register_agent",
    "注册新 Agent 到 Hub。需要有效的邀请码。注册成功返回 agent_id 和 api_token（仅显示一次）。",
    {
      invite_code: z.string().describe("邀请码（通过 /admin/invite/generate 获取）"),
      name:        z.string().describe("Agent 名称"),
      capabilities: z.array(z.string()).optional()
                    .describe("Agent 能力列表，如 ['mcp', 'sse', 'memory']"),
    },
    async ({ invite_code, name, capabilities }) => {
      // public 工具，不需要权限检查
      const result = registerAgentFromIdentity(invite_code, name, capabilities || []);
      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      auditLog("tool_register_agent", result.agentId ?? null, name, `role=${result.role ?? 'unknown'}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            agent_id: result.agentId,
            api_token: result.apiToken,
            role: result.role ?? "member",
            warning: "⚠️ api_token 仅显示一次，请妥善保存！",
            next_step: "使用此 Token 调用 heartbeat 工具上线，Token 通过 Authorization: Bearer <token> 传递",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // NEW Tool 2: heartbeat (Phase 1)
  // 上报心跳 — member 及以上
  // ────────────────────────────────────────────────────
  server.tool(
    "heartbeat",
    "上报 Agent 心跳，维持在线状态。Agent 上线后应每 30 秒调用一次。超过 90 秒无心跳将自动标记为离线。",
    {
      agent_id: z.string().describe("Agent ID（注册时返回的 agent_id）"),
    },
    async ({ agent_id }) => {
      const ctx = requireAuth(authContext, "heartbeat");

      // 验证调用者是 Agent 本人
      if (ctx.agentId !== agent_id && ctx.role !== "admin") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Cannot send heartbeat for another agent (admin only)",
            }),
          }],
        };
      }

      const result = heartbeatFromIdentity(agent_id);
      if (result.success) {
        // 清除离线通知标记
        clearOfflineNotification(agent_id);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // NEW Tool 3: query_agents (Phase 1)
  // 查询已注册 Agent — member 及以上
  // ────────────────────────────────────────────────────
  server.tool(
    "query_agents",
    "查询已注册的 Agent 列表。支持按状态、角色筛选。",
    {
      status:     z.enum(["online", "offline", "all"]).optional()
                  .default("all").describe("Agent 状态筛选"),
      role:       z.enum(["admin", "member", "group_admin"]).optional()
                  .describe("角色筛选"),
      capability: z.string().optional()
                  .describe("能力筛选"),
    },
    async ({ status, role, capability }) => {
      const ctx = requireAuth(authContext, "query_agents");

      const agents = queryAgentsFromIdentity({ status, role, capability });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agents,
            count: agents.length,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // NEW Tool 4: revoke_token (Phase 1)
  // 吊销 Token — admin only
  // ────────────────────────────────────────────────────
  server.tool(
    "revoke_token",
    "吊销 API Token，使其立即失效。仅 admin 可调用。",
    {
      token_id: z.string().describe("要吊销的 Token ID"),
    },
    async ({ token_id }) => {
      const ctx = requireAuth(authContext, "revoke_token");

      const success = revokeTokenFromSecurity(token_id);
      if (success) {
        auditLog("tool_revoke_token", ctx.agentId, token_id);

        // Phase 5a Day 2: token 吊销影响信任评分
        try {
          const tokenRow = db.prepare(`SELECT agent_id FROM auth_tokens WHERE token_id=?`).get(token_id) as any;
          if (tokenRow?.agent_id) {
            recalculateTrustScore(tokenRow.agent_id);
          }
        } catch {}
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success,
            token_id,
            note: success ? "Token 已吊销，使用该 Token 的 Agent 将无法访问" : "Token not found or already revoked",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // NEW Tool 4b: set_trust_score (Phase 2 Day 4)
  // 设置信任分 — admin only
  // ────────────────────────────────────────────────────
  server.tool(
    "set_trust_score",
    "调整 Agent 信任分（-100 到 +100 的增量）。信任分影响 collective 记忆搜索排序，高信任 Agent 的记忆排名靠前。仅 admin 可调用。",
    {
      agent_id: z.string().describe("目标 Agent ID"),
      delta:    z.number().min(-100).max(100).describe("信任分增量（正数加分，负数扣分）"),
    },
    async ({ agent_id, delta }) => {
      const ctx = requireAuth(authContext, "set_trust_score");

      const result = updateAgentTrustScore(agent_id, delta, ctx.agentId);

      if (!result.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:    true,
            agent_id,
            new_score:  result.new_score,
            delta,
            note:       result.new_score >= 80
              ? "🟢 高信任 Agent，记忆搜索排名优先"
              : result.new_score >= 30
                ? "🟡 正常信任分"
                : "🔴 低信任 Agent，记忆搜索排名靠后",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 5: send_message (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "send_message",
    "向另一个 Agent 发送即时消息。对方在线时实时送达（<50ms），离线时持久化存储，上线后自动补发。",
    {
      from:     z.string().describe("发送方 Agent ID，如 workbuddy 或 hermes"),
      to:       z.string().describe("接收方 Agent ID"),
      content:  z.string().describe("消息正文，支持 Markdown"),
      type:     z.enum(["message", "task_assign", "task_update", "ack"])
                  .default("message")
                  .describe("消息类型"),
      metadata: z.record(z.unknown()).optional()
                  .describe("附加结构化数据，如 taskId、priority 等"),
    },
    async ({ from, to, content, type, metadata }) => {
      const ctx = requireAuth(authContext, "send_message");

      // 消息去重 + 完整性校验
      const dedupResult = dedupMessage(from, to, content);
      if (!dedupResult.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: dedupResult.reason,
              code: "DEDUP_REJECTED",
            }),
          }],
        };
      }

      const msg: Message = {
        id:         randomUUID(),
        from_agent: from,
        to_agent:   to,
        content,
        type,
        metadata:   metadata ? JSON.stringify(metadata) : null,
        status:     "unread",
        created_at: Date.now(),
      };

      messageRepo.insert(msg);

      // 审计日志
      auditLog("tool_send_message", ctx.agentId, to,
        `msg_id=${msg.id}, hash=${dedupResult.msgHash.slice(0, 12)}, nonce=${dedupResult.nonce}`);

      const delivered = pushToAgent(to, {
        event:   "new_message",
        message: { ...msg, metadata, msg_hash: dedupResult.msgHash, nonce: dedupResult.nonce },
      });

      if (delivered) messageRepo.markDelivered(msg.id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:           true,
            messageId:         msg.id,
            msg_hash:          dedupResult.msgHash,
            nonce:             dedupResult.nonce,
            delivered_realtime: delivered,
            note: delivered
              ? `✅ ${to} 在线，已实时送达`
              : `📦 ${to} 离线，消息已存储，上线后自动补发`,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 6: assign_task (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "assign_task",
    "将任务分配给另一个 Agent。对方收到 task_assigned 事件后会自主开始执行，无需人工确认。",
    {
      from:        z.string().describe("发起方 Agent ID"),
      to:          z.string().describe("执行方 Agent ID"),
      description: z.string().describe("任务目标描述，尽量清晰，包含期望输出格式"),
      context:     z.string().optional()
                     .describe("执行任务所需背景信息，减少执行方反复询问"),
      priority:    z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    },
    async ({ from, to, description, context, priority }) => {
      requireAuth(authContext, "assign_task");

      const task: Task = {
        id:          `task_${Date.now()}_${randomUUID().slice(0, 6)}`,
        assigned_by: from,
        assigned_to: to,
        description,
        context:     context || null,
        priority,
        status:      "assigned",
        result:      null,
        progress:    0,
        pipeline_id:         null,
        order_index:         0,
        required_capability: null,
        due_at:              null,
        assigned_at:         Date.now(),
        completed_at:        null,
        tags:                "[]",
        created_at:  Date.now(),
        updated_at:  Date.now(),
      };

      taskRepo.insert(task);

      const delivered = pushToAgent(to, {
        event: "task_assigned",
        task: {
          ...task,
          instruction: [
            "你收到了一项新任务，请立即开始执行。",
            "执行前先调用 update_task_status（status=in_progress）告知发起方。",
            "完成后调用 update_task_status（status=completed）并携带结果。",
            "如遇问题，status=failed 并说明原因。",
          ].join(" "),
        },
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:    true,
            taskId:     task.id,
            assigned_to: to,
            priority,
            note: delivered
              ? `✅ ${to} 在线，任务已实时推送，对方将自主执行`
              : `📦 ${to} 离线，任务已存储，上线后立即推送执行`,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 7: update_task_status (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "update_task_status",
    "更新任务执行状态，自动实时通知发起方。支持中途汇报进度（in_progress + progress）。",
    {
      task_id:  z.string().describe("任务 ID"),
      agent_id: z.string().describe("执行方 Agent ID"),
      status:   z.enum(["in_progress", "completed", "failed"]),
      result:   z.string().optional().describe("执行结果或错误信息"),
      progress: z.number().min(0).max(100).optional().default(0)
                  .describe("完成百分比，0-100"),
    },
    async ({ task_id, agent_id, status, result, progress }) => {
      requireAuth(authContext, "update_task_status");

      const task = taskRepo.getById(task_id);
      if (!task) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Task ${task_id} not found` }),
          }],
        };
      }

      taskRepo.update(task_id, status, result || null, progress);

      pushToAgent(task.assigned_by, {
        event: "task_updated",
        update: {
          task_id,
          status,
          result,
          progress,
          updated_by: agent_id,
          timestamp:  Date.now(),
        },
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:    true,
            task_id,
            status,
            progress,
            notified:   task.assigned_by,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 8: get_task_status (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "get_task_status",
    "查询任务的当前状态、进度和执行结果。",
    {
      task_id: z.string(),
    },
    async ({ task_id }) => {
      requireAuth(authContext, "get_task_status");

      const task = taskRepo.getById(task_id);
      return {
        content: [{
          type: "text",
          text: task
            ? JSON.stringify(task, null, 2)
            : JSON.stringify({ error: "Task not found" }),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 9: broadcast_message (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "broadcast_message",
    "向多个 Agent 广播消息，适用于任务协调、状态同步、紧急通知。",
    {
      from:      z.string(),
      agent_ids: z.array(z.string()).describe("接收方 Agent ID 列表"),
      content:   z.string(),
      metadata:  z.record(z.unknown()).optional(),
    },
    async ({ from, agent_ids, content, metadata }) => {
      const ctx = requireAuth(authContext, "broadcast_message");

      // 消息体校验
      const validation = validateMessageBody(content);
      if (!validation.safe) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: validation.reason,
              code: "VALIDATION_REJECTED",
            }),
          }],
        };
      }

      const results: Record<string, boolean> = {};
      const errors: string[] = [];
      let deliveredCount = 0;

      for (const to of agent_ids) {
        // 每个接收者独立去重
        const dedupResult = dedupMessage(from, to, content);
        if (!dedupResult.ok) {
          errors.push(`${to}: ${dedupResult.reason}`);
          results[to] = false;
          continue;
        }

        const msg: Message = {
          id:         randomUUID(),
          from_agent: from,
          to_agent:   to,
          content,
          type:       "message",
          metadata:   metadata ? JSON.stringify(metadata) : null,
          status:     "unread",
          created_at: Date.now(),
        };
        messageRepo.insert(msg);
        const delivered = pushToAgent(to, {
          event: "new_message",
          message: { ...msg, metadata, msg_hash: dedupResult.msgHash, nonce: dedupResult.nonce },
        });
        if (delivered) {
          messageRepo.markDelivered(msg.id);
          deliveredCount++;
        }
        results[to] = delivered;
      }

      auditLog("tool_broadcast_message", ctx.agentId, agent_ids.join(","),
        `total=${agent_ids.length}, delivered=${deliveredCount}, errors=${errors.length}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            broadcast:       true,
            delivery_status: results,
            delivered_count: deliveredCount,
            duplicate_count: errors.length,
            errors:          errors.length > 0 ? errors : undefined,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 14: store_memory (Phase 1 Week 2)
  // 存储记忆 — member 及以上
  // ────────────────────────────────────────────────────
  server.tool(
    "store_memory",
    "存储一条记忆到 Hub。支持 private（仅自己可见）、group（组内可见）、collective（全局可见）三种范围。存储后可通过 recall_memory 全文搜索召回。",
    {
      content: z.string().describe("记忆内容（最多 10000 字符）"),
      title:   z.string().optional().describe("记忆标题（最多 500 字符）"),
      scope:   z.enum(["private", "group", "collective"]).optional()
                .default("private").describe("可见范围"),
      tags:    z.array(z.string()).optional().describe("标签列表，如 ['work', 'important']"),
      source_task_id: z.string().optional().describe("关联任务 ID（用于溯源追踪）"),
    },
    async ({ content, title, scope, tags, source_task_id }) => {
      const ctx = requireAuth(authContext, "store_memory");

      // Phase 2 Day 4: collective/group 写入自动记录 source_agent_id
      const sourceAgentId = scope === "collective" || scope === "group" ? ctx.agentId : undefined;

      const result = storeMemoryFromService(ctx.agentId, content, {
        title,
        scope,
        tags,
        source_agent_id: sourceAgentId,
        source_task_id,
      });

      if (!result.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      auditLog("tool_store_memory", ctx.agentId, result.memory.id,
        `scope=${scope}, source_agent=${sourceAgentId ?? "none"}, task=${source_task_id ?? "none"}, tags=${tags ? JSON.stringify(tags) : "none"}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:   true,
            memory_id: result.memory.id,
            scope:     result.memory.scope,
            source_agent_id: result.memory.source_agent_id,
            source_task_id:  result.memory.source_task_id,
            note:      scope === "collective"
              ? "🌐 全局记忆已存储，所有 Agent 可搜索到（已记录写入者溯源）"
              : scope === "group"
                ? "👥 组内记忆已存储，组内 Agent 可搜索到（已记录写入者溯源）"
                : "🔒 私有记忆已存储，仅自己可见",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 15: recall_memory (Phase 1 Week 2)
  // 全文搜索召回记忆 — member 及以上
  // ────────────────────────────────────────────────────
  server.tool(
    "recall_memory",
    "通过关键词全文搜索召回记忆。搜索范围包括自己的私有记忆、组内共享记忆和全局记忆。使用 FTS5 引擎，支持多关键词、短语搜索。",
    {
      query: z.string().describe("搜索关键词（如 'Agent 通信协议 错误修复'）"),
      scope: z.enum(["private", "group", "collective", "all"]).optional()
             .default("all").describe("搜索范围"),
      limit: z.number().min(1).max(50).optional().default(10)
             .describe("最大返回数量"),
    },
    async ({ query, scope, limit }) => {
      const ctx = requireAuth(authContext, "recall_memory");

      const results = recallMemory(query, ctx.agentId, { scope, limit });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query,
            scope,
            results: results.map(m => ({
              id:                m.id,
              title:             m.title,
              content:           m.content,
              scope:             m.scope,
              tags:              m.tags ? JSON.parse(m.tags) : [],
              agent_id:          m.agent_id,
              source_agent_id:   m.source_agent_id,
              source_task_id:    m.source_task_id,
              source_trust_score: (m as any).source_trust_score ?? null,
              created_at:        m.created_at,
            })),
            count: results.length,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 16: list_memories (Phase 1 Week 2)
  // 列出记忆 — member 及以上
  // ────────────────────────────────────────────────────
  server.tool(
    "list_memories",
    "列出可访问的记忆列表。按创建时间倒序排列。可按 scope 筛选。",
    {
      scope:  z.enum(["private", "group", "collective", "all"]).optional()
              .default("all").describe("可见范围筛选"),
      limit:  z.number().min(1).max(50).optional().default(20)
              .describe("最大返回数量"),
      offset: z.number().min(0).optional().default(0)
              .describe("分页偏移量"),
    },
    async ({ scope, limit, offset }) => {
      const ctx = requireAuth(authContext, "list_memories");

      const results = listMemories(ctx.agentId, { scope, limit, offset });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            memories: results.map(m => ({
              id:                m.id,
              title:             m.title,
              content:           m.content,
              scope:             m.scope,
              tags:              m.tags ? JSON.parse(m.tags) : [],
              agent_id:          m.agent_id,
              source_agent_id:   m.source_agent_id,
              source_task_id:    m.source_task_id,
              source_trust_score: (m as any).source_trust_score ?? null,
              created_at:        m.created_at,
              updated_at:        m.updated_at,
            })),
            count: results.length,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 17: delete_memory (Phase 1 Week 2)
  // 删除记忆 — 仅限自己（admin 可删除任何）
  // ────────────────────────────────────────────────────
  server.tool(
    "delete_memory",
    "删除一条记忆。仅能删除自己的私有记忆（admin 可删除任何记忆）。",
    {
      memory_id: z.string().describe("要删除的记忆 ID"),
    },
    async ({ memory_id }) => {
      const ctx = requireAuth(authContext, "delete_memory");

      const result = deleteMemoryFromService(memory_id, ctx.agentId, ctx.role);

      if (!result.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      auditLog("tool_delete_memory", ctx.agentId, memory_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:    true,
            memory_id,
            note:       "记忆已永久删除",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 10: get_online_agents (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "get_online_agents",
    "查询当前通过 SSE 在线连接的 Agent 列表，分配任务前可先确认对方在线。",
    {},
    async () => {
      requireAuth(authContext, "get_online_agents");

      const online = onlineAgents();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            online_agents: online,
            count: online.length,
            timestamp: Date.now(),
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 11: acknowledge_message (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "acknowledge_message",
    "标记消息为已处理（acknowledged）。调用此工具后该消息不会再出现在未处理消息列表中。Hermes 处理完 WorkBuddy 发来的消息并回复后，必须调用此工具。",
    {
      message_id: z.string().describe("消息 ID"),
      agent_id:   z.string().describe("确认方 Agent ID，如 hermes"),
    },
    async ({ message_id, agent_id }) => {
      requireAuth(authContext, "acknowledge_message");

      try {
        const msg = await withRetry(
          () => messageRepo.getById(message_id),
          "acknowledge_message:lookup"
        );
        if (!msg) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: `Message ${message_id} not found`, suggestion: "请检查 message_id 是否正确" }),
            }],
          };
        }
        await withRetry(
          () => messageRepo.markAcknowledged(message_id),
          "acknowledge_message:update"
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:    true,
              message_id,
              agent_id,
              status:     "acknowledged",
              note:       "此消息已标记为已处理，不会重复出现在待处理列表中",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        logError("acknowledge_message_error", err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: err.message,
              fallback: "标记失败，消息仍为当前状态，请稍后重试",
            }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 12: mark_consumed (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "mark_consumed",
    "记录 Agent 已处理某个资源（文件路径或信号 ID）。处理完 WorkBuddy 发来的任何文件或信号后必须调用，防止下次重复处理。",
    {
      agent_id:      z.string().describe("执行方 Agent ID，如 hermes"),
      resource:      z.string().describe("文件路径（相对 shared 目录）或信号 ID"),
      resource_type: z.enum(["file", "signal", "message"]).default("file"),
      action:        z.string().describe("执行的动作，如 reviewed_and_replied / acknowledged / processed"),
      notes:         z.string().optional().describe("处理说明，方便日后追溯"),
    },
    async ({ agent_id, resource, resource_type, action, notes }) => {
      requireAuth(authContext, "mark_consumed");

      try {
        const entry: ConsumedEntry = {
          id:            randomUUID(),
          agent_id,
          resource,
          resource_type,
          action,
          notes:         notes || null,
          consumed_at:   Date.now(),
        };
        await withRetry(
          () => consumedRepo.insert(entry),
          "mark_consumed:insert"
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:      true,
              resource,
              resource_type,
              action,
              consumed_at:  new Date(entry.consumed_at).toISOString(),
              note:         "已记录消费水位线，下次不会重复处理此资源",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        logError("mark_consumed_error", err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: err.message,
              fallback: "水位线记录失败，建议稍后重试或检查 Hub 服务状态",
            }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 13: check_consumed (原有，添加权限检查)
  // ────────────────────────────────────────────────────
  server.tool(
    "check_consumed",
    "查询某资源是否已被当前 Agent 处理过。在处理 WorkBuddy 发来的文件或信号前，先调用此工具检查，已处理的直接跳过。",
    {
      agent_id: z.string().describe("Agent ID，如 hermes"),
      resource: z.string().describe("文件路径或信号 ID"),
    },
    async ({ agent_id, resource }) => {
      requireAuth(authContext, "check_consumed");

      try {
        const record = await withRetry(
          () => consumedRepo.check(agent_id, resource),
          "check_consumed:query"
        );
        if (record) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                consumed:     true,
                resource,
                action:       record.action,
                notes:        record.notes,
                consumed_at:  new Date(record.consumed_at).toISOString(),
                advice:       "此资源已处理过，无需重复操作。如需重新处理，请通知 WorkBuddy 发送新版本。",
              }, null, 2),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              consumed: false,
              resource,
              advice:   "此资源尚未处理，可以正常处理。处理完成后请调用 mark_consumed 记录水位线。",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        logError("check_consumed_error", err);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              consumed: false,
              resource,
              warning: `水位线查询失败: ${err.message}`,
              advice:   "无法确认是否已处理（查询出错），建议继续处理并在完成后调用 mark_consumed",
            }, null, 2),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 3: Evolution Engine 工具
  // ────────────────────────────────────────────────────

  // Tool E1: share_experience — member 及以上
  server.tool(
    "share_experience",
    "分享经验到 Hub。经验直接发布（不需审批），所有 Agent 可见。适合记录踩坑经验、最佳实践。",
    {
      title:   z.string().min(3).max(200).describe("经验标题"),
      content: z.string().min(10).max(5000).describe("经验内容（Markdown，最多 5000 字符）"),
      tags:    z.array(z.string()).max(10).optional().describe("标签列表，如 ['debugging', 'mcp']"),
      task_id: z.string().optional().describe("关联任务 ID"),
    },
    async ({ title, content, tags, task_id }) => {
      const ctx = requireAuth(authContext, "share_experience");

      const result = shareExperience(title, content, ctx.agentId, { task_id });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      auditLog("tool_share_experience", ctx.agentId, String(result.strategy.id),
        `title=${title.slice(0, 50)}, tags=${tags ? JSON.stringify(tags) : "none"}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:      true,
            strategy_id:  result.strategy.id,
            status:        "approved",
            category:      "experience",
            note:          "经验已发布，所有 Agent 可通过 search_strategies 搜索到",
          }, null, 2),
        }],
      };
    }
  );

  // Tool E2: propose_strategy — member 及以上
  server.tool(
    "propose_strategy",
    "提议一个策略。策略需 admin 审批后才能被其他 Agent 搜索和采纳。Hub 会自动判定敏感级别。",
    {
      title:    z.string().min(3).max(200).describe("策略标题"),
      content:  z.string().min(10).max(5000).describe("策略内容（Markdown，最多 5000 字符）"),
      category: z.enum(["workflow", "fix", "tool_config", "prompt_template", "other"])
                .describe("策略分类"),
      task_id:  z.string().optional().describe("关联任务 ID"),
    },
    async ({ title, content, category, task_id }) => {
      const ctx = requireAuth(authContext, "propose_strategy");

      const result = proposeStrategy(title, content, category, ctx.agentId, { task_id });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      auditLog("tool_propose_strategy", ctx.agentId, String(result.strategy.id),
        `category=${category}, sensitivity=${result.sensitivity}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:     true,
            strategy_id: result.strategy.id,
            status:       "pending",
            category,
            sensitivity:  result.sensitivity,
            note: result.sensitivity === "high"
              ? "⚠️ 高敏感策略，审批流程更严格"
              : "策略已提交，等待 admin 审批",
          }, null, 2),
        }],
      };
    }
  );

  // Tool E3: list_strategies — member 及以上
  server.tool(
    "list_strategies",
    "查询策略/经验列表。支持按状态、分类、提议者筛选。",
    {
      status:      z.enum(["pending", "approved", "rejected", "all"]).optional().describe("状态筛选"),
      category:    z.enum(["experience", "workflow", "fix", "tool_config", "prompt_template", "other", "all"]).optional().describe("分类筛选"),
      proposer_id: z.string().optional().describe("提议者 Agent ID"),
      limit:       z.number().min(1).max(50).optional().default(20).describe("最大返回数量"),
    },
    async ({ status, category, proposer_id, limit }) => {
      const ctx = requireAuth(authContext, "list_strategies");

      const strategies = listStrategies({ status, category, proposer_id, limit });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            strategies: strategies.map(s => ({
              id: s.id,
              title: s.title,
              category: s.category,
              sensitivity: s.sensitivity,
              proposer_id: s.proposer_id,
              status: s.status,
              source_trust: s.source_trust,
              apply_count: s.apply_count,
              feedback_count: s.feedback_count,
              positive_count: s.positive_count,
              proposed_at: s.proposed_at,
              approved_at: s.approved_at,
            })),
            count: strategies.length,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // Tool E4: search_strategies — member 及以上
  server.tool(
    "search_strategies",
    "通过关键词全文搜索策略和经验。仅返回已审批（approved）的策略。",
    {
      query:    z.string().min(2).max(200).describe("搜索关键词（支持中文 N-gram 分词）"),
      category: z.string().optional().describe("分类筛选"),
      limit:    z.number().min(1).max(20).optional().default(10).describe("最大返回数量"),
    },
    async ({ query, category, limit }) => {
      const ctx = requireAuth(authContext, "search_strategies");

      const results = searchStrategies(query, { category, limit });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query,
            results: results.map(s => ({
              id: s.id,
              title: s.title,
              content: s.content,
              category: s.category,
              proposer_id: s.proposer_id,
              apply_count: s.apply_count,
              feedback_count: s.feedback_count,
              positive_count: s.positive_count,
            })),
            count: results.length,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // Tool E5: apply_strategy — member 及以上
  server.tool(
    "apply_strategy",
    "采纳一个已审批的策略。记录到策略应用记录中，apply_count 自增。",
    {
      strategy_id: z.number().describe("策略 ID"),
      context:     z.string().max(500).optional().describe("应用场景描述"),
    },
    async ({ strategy_id, context }) => {
      const ctx = requireAuth(authContext, "apply_strategy");

      const result = applyStrategy(strategy_id, ctx.agentId, { context });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      auditLog("tool_apply_strategy", ctx.agentId, String(strategy_id));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:         true,
            application_id:  result.application_id,
            strategy_id,
            note:            "策略已采纳，已记录应用历史",
          }, null, 2),
        }],
      };
    }
  );

  // Tool E6: feedback_strategy — member 及以上
  server.tool(
    "feedback_strategy",
    "对策略提供反馈（正面/负面/中性）。每个 Agent 对每个策略只能反馈一次（防刷）。",
    {
      strategy_id: z.number().describe("策略 ID"),
      feedback:    z.enum(["positive", "negative", "neutral"]).describe("反馈类型"),
      comment:     z.string().max(500).optional().describe("反馈备注"),
      applied:     z.boolean().optional().describe("是否实际采纳到工作中"),
    },
    async ({ strategy_id, feedback, comment, applied }) => {
      const ctx = requireAuth(authContext, "feedback_strategy");

      const result = feedbackStrategy(strategy_id, ctx.agentId, feedback, { comment, applied });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      auditLog("tool_feedback_strategy", ctx.agentId, String(strategy_id), `feedback=${feedback}`);

      // Phase 5a Day 2: 反馈影响信任评分
      try { recalculateTrustScore(ctx.agentId); } catch {}

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:     true,
            feedback_id: result.feedback_id,
            strategy_id,
            feedback,
            note:       "反馈已记录，感谢你的贡献",
          }, null, 2),
        }],
      };
    }
  );

  // Tool A1: approve_strategy — admin only
  server.tool(
    "approve_strategy",
    "审批策略（approve/reject）。仅 admin 可调用。审批后通过 SSE 通知提议者。",
    {
      strategy_id: z.number().describe("策略 ID"),
      action:      z.enum(["approve", "reject"]).describe("审批动作"),
      reason:      z.string().max(1000).describe("审批理由"),
    },
    async ({ strategy_id, action, reason }) => {
      const ctx = requireAuth(authContext, "approve_strategy");

      const result = approveStrategy(strategy_id, ctx.agentId, action, reason);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      // 动态导入 pushToAgent（避免循环依赖）
      const { pushToAgent } = await import("./sse.js");

      auditLog("tool_approve_strategy", ctx.agentId, String(strategy_id),
        `action=${action}, status=${result.strategy.status}`);

      // SSE 通知提议者
      pushToAgent(result.strategy.proposer_id, {
        event: "strategy_approved",
        strategy: {
          id: result.strategy.id,
          title: result.strategy.title,
          status: result.strategy.status,
          action,
          reason,
          approved_by: ctx.agentId,
          approved_at: Date.now(),
        },
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:     true,
            strategy_id: result.strategy.id,
            new_status:  result.strategy.status,
            action,
            reason,
            proposer_notified: true,
            note: action === "approve"
              ? "策略已通过审批，所有 Agent 现在可以搜索和采纳"
              : "策略已拒绝，提议者已收到通知",
          }, null, 2),
        }],
      };
    }
  );

  // Tool A2: get_evolution_status — member 及以上
  server.tool(
    "get_evolution_status",
    "查看 Evolution Engine 进化指标统计。包含经验数、策略数、审批率、贡献者排名等。",
    {},
    async () => {
      const ctx = requireAuth(authContext, "get_evolution_status");

      const stats = getEvolutionStatus();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...stats,
            queried_by: ctx.agentId,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 4b Day 2: 依赖链 + 并行组工具
  // ────────────────────────────────────────────────────

  // Tool D1: add_dependency — member 及以上
  server.tool(
    "add_dependency",
    "添加任务依赖关系。下游任务必须等上游任务完成后才能开始。自动进行环检测。添加后下游任务自动进入等待状态。",
    {
      upstream_id:   z.string().describe("上游任务 ID（需先完成）"),
      downstream_id: z.string().describe("下游任务 ID（依赖上游完成后才能开始）"),
      dep_type:      z.enum(["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"])
                     .optional().default("finish_to_start")
                     .describe("依赖类型，默认 finish_to_start"),
    },
    async ({ upstream_id, downstream_id, dep_type }) => {
      const ctx = requireAuth(authContext, "add_dependency");

      try {
        const result = addDep(upstream_id, downstream_id, dep_type as any, ctx.agentId);

        auditLog("tool_add_dependency", ctx.agentId, upstream_id,
          `→${downstream_id}(${dep_type}), downstream_updated=${result.downstream_updated}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:            true,
              dependency_id:      result.dependency.id,
              upstream_id,
              downstream_id,
              dep_type,
              downstream_updated: result.downstream_updated,
              hint: result.downstream_updated
                ? "下游任务状态已更新（waiting 或 ready）"
                : "下游任务状态未变更（上游已完成或下游在终态）",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool D2: remove_dependency — member 及以上
  server.tool(
    "remove_dependency",
    "删除任务依赖关系。删除后自动检查下游任务是否可以开始执行。",
    {
      upstream_id:   z.string().describe("上游任务 ID"),
      downstream_id: z.string().describe("下游任务 ID"),
    },
    async ({ upstream_id, downstream_id }) => {
      const ctx = requireAuth(authContext, "remove_dependency");

      try {
        const result = removeDep(upstream_id, downstream_id, ctx.agentId);

        auditLog("tool_remove_dependency", ctx.agentId, upstream_id,
          `→${downstream_id}, downstream_ready=${result.downstream_ready}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:          true,
              upstream_id,
              downstream_id,
              removed:          result.removed,
              downstream_ready: result.downstream_ready,
              hint: result.downstream_ready
                ? "下游任务已从 waiting 恢复为可执行状态"
                : "下游任务仍有其他未满足依赖，保持 waiting",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool D3: get_task_dependencies — member 及以上
  server.tool(
    "get_task_dependencies",
    "查询任务的上下游依赖关系。返回依赖图，包含每个关联任务的状态和依赖类型。",
    {
      task_id: z.string().describe("要查询的任务 ID"),
    },
    async ({ task_id }) => {
      const ctx = requireAuth(authContext, "get_task_dependencies");

      try {
        const deps = getDeps(task_id);
        const check = checkDepsSatisfied(task_id);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              task_id,
              dependencies_satisfied: check.satisfied,
              pending_deps:           check.pending_deps,
              upstreams:              deps.upstreams,
              downstreams:            deps.downstreams,
              queried_by:             ctx.agentId,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool D4: create_parallel_group — member 及以上
  server.tool(
    "create_parallel_group",
    "将多个任务标记为并行组。同一并行组内的任务可以同时执行，无需等待其他任务完成。适用于无依赖关系的同层任务。",
    {
      task_ids: z.array(z.string()).min(2).max(10)
               .describe("并行任务 ID 列表（至少 2 个，最多 10 个）"),
    },
    async ({ task_ids }) => {
      const ctx = requireAuth(authContext, "create_parallel_group");

      try {
        const result = createParallelGroup(task_ids, ctx.agentId);

        auditLog("tool_create_parallel_group", ctx.agentId, result.group_id,
          `task_count=${result.task_count}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:   true,
              group_id:  result.group_id,
              task_count: result.task_count,
              tasks:     result.tasks,
              hint:      "同一并行组内的任务可以同时执行，互不阻塞",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 4b Day 3: 交接协议工具
  // ────────────────────────────────────────────────────

  // Tool H1: request_handoff — member 及以上
  server.tool(
    "request_handoff",
    "请求任务交接。将任务转交给另一个 Agent。目标 Agent 需要调用 accept_handoff 或 reject_handoff。只有负责人或创建者可以发起交接。",
    {
      task_id:        z.string().describe("要交接的任务 ID"),
      target_agent_id: z.string().describe("目标 Agent ID（交接对象）"),
    },
    async ({ task_id, target_agent_id }) => {
      const ctx = requireAuth(authContext, "request_handoff");

      try {
        const result = requestHandoff(task_id, target_agent_id, ctx.agentId);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:        true,
              task_id:        result.task_id,
              handoff_status: result.handoff_status,
              from:           result.from,
              to:             result.to,
              hint:           `已向 ${target_agent_id} 发送交接请求，等待对方响应`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool H2: accept_handoff — member 及以上
  server.tool(
    "accept_handoff",
    "接受任务交接。只有被请求的 target Agent 可以调用。接受后任务 assigned_to 转移到当前 Agent。",
    {
      task_id: z.string().describe("要接受的任务 ID"),
    },
    async ({ task_id }) => {
      const ctx = requireAuth(authContext, "accept_handoff");

      try {
        const result = acceptHandoff(task_id, ctx.agentId);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:      true,
              task_id:      result.task_id,
              new_assignee: result.new_assignee,
              hint:         "你已接管此任务。调用 update_task_status(in_progress) 开始执行。",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool H3: reject_handoff — member 及以上
  server.tool(
    "reject_handoff",
    "拒绝任务交接。只有被请求的 target Agent 可以调用。拒绝后交接请求取消。",
    {
      task_id: z.string().describe("要拒绝的任务 ID"),
      reason:  z.string().optional().describe("拒绝原因"),
    },
    async ({ task_id, reason }) => {
      const ctx = requireAuth(authContext, "reject_handoff");

      try {
        const result = rejectHandoff(task_id, ctx.agentId, reason);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:     true,
              task_id:     result.task_id,
              rejected_by: result.rejected_by,
              reason:      result.reason,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 4b Day 3: 质量门工具
  // ────────────────────────────────────────────────────

  // Tool Q1: add_quality_gate — member 及以上
  server.tool(
    "add_quality_gate",
    "在 Pipeline 中添加质量门。质量门在指定 order_index 之后阻塞后续任务，直到评估通过。criteria 为 JSON 格式的检查规则。",
    {
      pipeline_id: z.string().describe("Pipeline ID"),
      gate_name:   z.string().describe("质量门名称"),
      criteria:    z.string().describe("评估规则（JSON 格式，如 {\"type\":\"manual\",\"check\":\"code_review\"}）"),
      after_order: z.number().int().min(0).describe("在哪个 order_index 之后的任务需要等待此质量门通过"),
    },
    async ({ pipeline_id, gate_name, criteria, after_order }) => {
      const ctx = requireAuth(authContext, "add_quality_gate");

      try {
        const result = addQGate(pipeline_id, gate_name, criteria, after_order, ctx.agentId);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:     true,
              gate_id:     result.gate.id,
              pipeline_id: result.pipeline_id,
              gate_name:   result.gate.gate_name,
              after_order: result.gate.after_order,
              status:      "pending",
              hint:        "质量门已创建，等待 evaluate_quality_gate 评估",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool Q2: evaluate_quality_gate — member 及以上
  server.tool(
    "evaluate_quality_gate",
    "评估质量门（通过/失败）。质量门失败时，Pipeline 中阻塞的后续任务自动进入 waiting 状态。",
    {
      gate_id:     z.string().describe("质量门 ID"),
      status:      z.enum(["passed", "failed"]).describe("评估结果"),
      result:      z.string().optional().describe("评估说明"),
    },
    async ({ gate_id, status, result }) => {
      const ctx = requireAuth(authContext, "evaluate_quality_gate");

      try {
        const evalResult = evalQGate(gate_id, status, ctx.agentId, result);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:       true,
              gate_id:       evalResult.gate_id,
              status:        evalResult.status,
              blocked_tasks: evalResult.blocked_tasks,
              hint: evalResult.blocked_tasks.length > 0
                ? `质量门未通过，${evalResult.blocked_tasks.length} 个任务已暂停`
                : evalResult.status === "passed"
                  ? "质量门已通过，后续任务可继续执行"
                  : "质量门评估完成",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 4b Day 4: 分级审批工具
  // ────────────────────────────────────────────────────

  // Tool T1: propose_strategy_tiered — member 及以上
  server.tool(
    "propose_strategy_tiered",
    "提议策略（分级审批）。Hub 自动判定审批等级：auto（自动通过+72h观察窗口）、peer（同行审批）、admin（管理员审批）、super（高风险，需人工审批）。返回判定等级和审批状态。",
    {
      title:    z.string().min(3).max(200).describe("策略标题"),
      content:  z.string().min(10).max(5000).describe("策略内容（Markdown，最多 5000 字符）"),
      category: z.enum(["workflow", "fix", "tool_config", "prompt_template", "other"])
                .describe("策略分类"),
      task_id:  z.string().optional().describe("关联任务 ID"),
    },
    async ({ title, content, category, task_id }) => {
      const ctx = requireAuth(authContext, "propose_strategy_tiered");

      const result = proposeStrategyTiered(title, content, category, ctx.agentId, { task_id });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      auditLog("tool_propose_strategy_tiered", ctx.agentId, String(result.strategy.id),
        `tier=${result.tier}, sensitivity=${result.sensitivity}, auto_approved=${result.auto_approved}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:        true,
            strategy_id:    result.strategy.id,
            status:         result.strategy.status,
            tier:           result.tier,
            sensitivity:    result.sensitivity,
            auto_approved:  result.auto_approved,
            veto_deadline:  result.veto_deadline,
            note: result.tier === "auto"
              ? "✅ 自动通过审批，72h 观察窗口已启动"
              : result.tier === "peer"
                ? "📋 已提交，需 peer 审批"
                : result.tier === "super"
                  ? "⚠️ 高风险策略，需 super 人工审批"
                  : "📋 已提交，需 admin 审批",
          }, null, 2),
        }],
      };
    }
  );

  // Tool T2: check_veto_window — member 及以上
  server.tool(
    "check_veto_window",
    "检查策略的否决窗口状态。处于 48h 否决窗口内的策略，如果负面反馈超过正面反馈的 50%，可被 admin 撤回。",
    {
      strategy_id: z.number().describe("策略 ID"),
    },
    async ({ strategy_id }) => {
      const ctx = requireAuth(authContext, "check_veto_window");

      const result = checkVetoWindow(strategy_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:         true,
            strategy_id,
            ...result,
            note: result.in_window
              ? result.can_veto
                ? `⚠️ 否决窗口内，负面反馈比 ${result.veto_ratio} > 0.5，可被 admin 撤回`
                : `🔒 否决窗口内，但负面反馈比 ${result.veto_ratio} <= 0.5，暂不可撤回`
              : "否决窗口已过，策略已稳固",
          }, null, 2),
        }],
      };
    }
  );

  // Tool T3: veto_strategy — admin only
  server.tool(
    "veto_strategy",
    "撤回处于否决窗口内的策略（admin only）。仅在负面反馈超过正面反馈 50% 时可用。",
    {
      strategy_id: z.number().describe("策略 ID"),
      reason:      z.string().max(1000).describe("撤回理由"),
    },
    async ({ strategy_id, reason }) => {
      const ctx = requireAuth(authContext, "veto_strategy");

      const result = vetoStrategyFromEvolution(strategy_id, ctx.agentId, reason);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:     true,
            strategy_id,
            new_status:  "rejected",
            vetoed_by:   ctx.agentId,
            reason,
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 5a: set_agent_role — admin only
  // 任命/撤销 group_admin，或调整角色
  // ────────────────────────────────────────────────────
  server.tool(
    "set_agent_role",
    "设置 Agent 角色（admin/member/group_admin）。group_admin 需指定 managed_group_id，仅能管理该 parallel_group 内成员的任务。仅 admin 可调用。",
    {
      agent_id:          z.string().describe("目标 Agent ID"),
      role:              z.enum(["admin", "member", "group_admin"]).describe("新角色"),
      managed_group_id:  z.string().optional().describe("管理组 ID（仅 group_admin 角色需要）"),
    },
    async ({ agent_id, role, managed_group_id }) => {
      const ctx = requireAuth(authContext, "set_agent_role");

      const result = setAgentRoleFromIdentity(agent_id, role, ctx.agentId, managed_group_id);

      if (!result.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: result.error }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:     true,
            agent_id,
            old_role:    result.old_role,
            new_role:    result.new_role,
            managed_group_id: result.managed_group_id,
            note: result.new_role === "group_admin"
              ? "group_admin 可管理指定 parallel_group 内成员的任务"
              : result.new_role === "member"
                ? "已降级为普通成员"
                : "管理员权限（完全控制）",
          }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 5a: recalculate_trust_scores — admin only
  // 手动触发信任分重算（admin 覆盖自动值后可用此工具重置）
  // ────────────────────────────────────────────────────
  server.tool(
    "recalculate_trust_scores",
    "手动触发信任评分重算。基于多因子自动计算：verified capabilities (+3)、approved strategies (+2)、positive feedback (+1)、negative feedback (-2)、rejected applications (-3)、revoked tokens (-10)。不传 agent_id 则重算全部。仅 admin 可调用。",
    {
      agent_id: z.string().optional().describe("目标 Agent ID（不传则重算全部 Agent）"),
    },
    async ({ agent_id }) => {
      const ctx = requireAuth(authContext, "recalculate_trust_scores");

      try {
        if (agent_id) {
          const score = recalculateTrustScore(agent_id);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                agent_id,
                new_score: score,
                note: "信任评分已重新计算并写入 agents.trust_score",
              }, null, 2),
            }],
          };
        } else {
          const results = recalculateAllTrustScores();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                total_agents: results.length,
                scores: results,
                note: `已重算 ${results.length} 个 Agent 的信任评分`,
              }, null, 2),
            }],
          };
        }
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 6: Pipeline MCP 工具
  // ────────────────────────────────────────────────────

  // Tool P1: create_pipeline — member 及以上
  server.tool(
    "create_pipeline",
    "创建一个新的 Pipeline（任务流水线）。Pipeline 是任务的有序容器，可添加质量门进行阶段性质量检查。",
    {
      name:        z.string().describe("Pipeline 名称"),
      description: z.string().optional().describe("Pipeline 描述"),
    },
    async ({ name, description }) => {
      const ctx = requireAuth(authContext, "create_pipeline");

      try {
        const pipeline = createPipeline({
          name,
          description,
          creator: ctx.agentId,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:     true,
              pipeline_id: pipeline.id,
              name:        pipeline.name,
              status:      pipeline.status,
              note:        "Pipeline 已创建（draft 状态）。使用 add_task_to_pipeline 添加任务，完成后调用 update_pipeline_status 激活。",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool P2: get_pipeline — member 及以上
  server.tool(
    "get_pipeline",
    "查询 Pipeline 状态和进度。返回 Pipeline 信息、关联任务列表及各状态统计。",
    {
      pipeline_id: z.string().describe("Pipeline ID"),
    },
    async ({ pipeline_id }) => {
      const ctx = requireAuth(authContext, "get_pipeline");

      try {
        const result = getPipelineStatus(pipeline_id);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              pipeline:  result.pipeline,
              tasks:     result.tasks.map(t => ({
                id:             t.id,
                description:    t.description,
                status:         t.status,
                progress:       t.progress,
                assigned_to:    t.assigned_to,
                order_index:    (t as any).order_index,
              })),
              stats:     result.stats,
              queried_by: ctx.agentId,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool P3: list_pipelines — member 及以上
  server.tool(
    "list_pipelines",
    "列出所有 Pipeline。支持按状态筛选，按创建时间倒序排列。",
    {
      status: z.enum(["active", "completed", "cancelled", "all"]).optional()
              .default("all").describe("状态筛选"),
      limit:  z.number().min(1).max(50).optional().default(20)
              .describe("最大返回数量"),
    },
    async ({ status, limit }) => {
      const ctx = requireAuth(authContext, "list_pipelines");

      try {
        const conditions: string[] = [];
        const params: any[] = [];

        if (status !== "all") {
          conditions.push("status = ?");
          params.push(status);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const pipelines = db.prepare(
          `SELECT * FROM pipelines ${where} ORDER BY created_at DESC LIMIT ?`
        ).all(...params, limit) as any[];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              pipelines: pipelines.map(p => ({
                id:          p.id,
                name:        p.name,
                description: p.description,
                status:      p.status,
                creator:     p.creator,
                created_at:  p.created_at,
                updated_at:  p.updated_at,
              })),
              count:      pipelines.length,
              queried_by: ctx.agentId,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool P4: add_task_to_pipeline — member 及以上
  server.tool(
    "add_task_to_pipeline",
    "将任务添加到 Pipeline。指定任务在 Pipeline 中的顺序。不传 order_index 则自动追加到末尾。",
    {
      pipeline_id:  z.string().describe("Pipeline ID"),
      task_id:      z.string().describe("任务 ID"),
      order_index:  z.number().int().min(0).optional().describe("顺序索引（不传则自动追加到末尾）"),
    },
    async ({ pipeline_id, task_id, order_index }) => {
      const ctx = requireAuth(authContext, "add_task_to_pipeline");

      try {
        const result = addTaskToPipeline(pipeline_id, task_id, order_index, ctx.agentId);

        auditLog("tool_add_task_to_pipeline", ctx.agentId, pipeline_id,
          `task=${task_id}, order=${result.order_index}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:       true,
              pipeline_task_id: result.id,
              pipeline_id,
              task_id,
              order_index:   result.order_index,
              note:          "任务已添加到 Pipeline",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // ────────────────────────────────────────────────────
  // Phase 6: 消息搜索 MCP 工具
  // ────────────────────────────────────────────────────

  // Tool S1: search_messages — member 及以上
  server.tool(
    "search_messages",
    "全文搜索消息内容。支持按 Agent ID 筛选。使用 SQL LIKE 模糊匹配（暂无 FTS5 索引）。",
    {
      query:    z.string().describe("搜索关键词"),
      agent_id: z.string().optional().describe("限定 Agent ID（按发送方或接收方过滤）"),
      limit:    z.number().min(1).max(50).optional().default(10).describe("最大返回数量"),
    },
    async ({ query, agent_id, limit }) => {
      const ctx = requireAuth(authContext, "search_messages");

      try {
        const conditions: string[] = ["content LIKE ?"];
        const params: any[] = [`%${query}%`];

        if (agent_id) {
          conditions.push("(from_agent = ? OR to_agent = ?)");
          params.push(agent_id, agent_id);
        }

        const where = conditions.join(" AND ");
        const messages = db.prepare(
          `SELECT id, from_agent, to_agent, content, type, status, created_at
           FROM messages WHERE ${where}
           ORDER BY created_at DESC LIMIT ?`
        ).all(...params, limit) as any[];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              agent_id: agent_id ?? null,
              messages: messages.map(m => ({
                id:         m.id,
                from_agent: m.from_agent,
                to_agent:   m.to_agent,
                content:    m.content,
                type:       m.type,
                status:     m.status,
                created_at: m.created_at,
              })),
              count:      messages.length,
              queried_by: ctx.agentId,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );

  // Tool S2: search_memories — member 及以上
  server.tool(
    "search_memories",
    "全文搜索记忆内容。使用 FTS5 引擎，支持多关键词、短语搜索。可按可见范围和标签筛选。",
    {
      query: z.string().describe("搜索关键词（如 '通信协议 错误修复'）"),
      scope: z.enum(["private", "group", "collective", "all"]).optional()
             .default("all").describe("可见范围筛选"),
      tags:  z.array(z.string()).optional().describe("标签筛选（如 ['work', 'important']）"),
      limit: z.number().min(1).max(50).optional().default(10).describe("最大返回数量"),
    },
    async ({ query, scope, tags, limit }) => {
      const ctx = requireAuth(authContext, "search_memories");

      try {
        // 复用已有的 recallMemory（FTS5 引擎）
        let results = recallMemory(query, ctx.agentId, { scope, limit });

        // 按 tags 过滤（recallMemory 不直接支持 tags 参数）
        if (tags && tags.length > 0) {
          results = results.filter(m => {
            if (!m.tags) return false;
            try {
              const parsedTags: string[] = JSON.parse(m.tags);
              return tags.some(t => parsedTags.includes(t));
            } catch {
              return false;
            }
          });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              scope,
              tags:  tags ?? null,
              memories: results.map(m => ({
                id:                m.id,
                title:             m.title,
                content:           m.content,
                scope:             m.scope,
                tags:              m.tags ? JSON.parse(m.tags) : [],
                agent_id:          m.agent_id,
                source_agent_id:   m.source_agent_id,
                source_task_id:    m.source_task_id,
                source_trust_score: (m as any).source_trust_score ?? null,
                created_at:        m.created_at,
              })),
              count:      results.length,
              queried_by: ctx.agentId,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: false, error: err.message }),
          }],
        };
      }
    }
  );
}
