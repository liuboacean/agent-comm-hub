/**
 * tools.ts — MCP 工具定义
 * 全部 6 个工具，注册到 McpServer
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db, msgStmt, taskStmt, type Message, type Task } from "./db.js";
import { pushToAgent, broadcast, onlineAgents } from "./sse.js";

export function registerTools(server: McpServer): void {

  // ────────────────────────────────────────────────────
  // Tool 1: send_message
  // 发送即时消息，对方在线 < 50ms 送达，离线自动存库补发
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

      msgStmt.insert.run(msg);

      const delivered = pushToAgent(to, {
        event:   "new_message",
        message: { ...msg, metadata },
      });

      if (delivered) msgStmt.markDelivered.run(msg.id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success:          true,
            messageId:        msg.id,
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
  // Tool 2: assign_task
  // 分配任务，接收方收到 task_assigned 事件后自主执行
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
      const task: Task = {
        id:          `task_${Date.now()}_${randomUUID().slice(0, 6)}`,
        assigned_by: from,
        assigned_to: to,
        description,
        context:     context || null,
        priority,
        status:      "pending",
        result:      null,
        progress:    0,
        created_at:  Date.now(),
        updated_at:  Date.now(),
      };

      taskStmt.insert.run(task);

      // 推送 task_assigned 事件——Agent 事件处理器捕获后自主启动工作
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
  // Tool 3: update_task_status
  // 执行方汇报进度/结果，自动通知发起方
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
      const task = taskStmt.getById.get(task_id) as Task | undefined;
      if (!task) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: `Task ${task_id} not found` }),
          }],
        };
      }

      taskStmt.update.run(status, result || null, progress, Date.now(), task_id);

      // 实时通知发起方
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
  // Tool 4: get_task_status
  // 查询任务当前状态（不消耗 SSE，适合主动轮查）
  // ────────────────────────────────────────────────────
  server.tool(
    "get_task_status",
    "查询任务的当前状态、进度和执行结果。",
    {
      task_id: z.string(),
    },
    async ({ task_id }) => {
      const task = taskStmt.getById.get(task_id) as Task | undefined;
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
  // Tool 5: broadcast_message
  // 向多个 Agent 广播，适合协调多 Agent 并行任务
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
      const results: Record<string, boolean> = {};
      for (const to of agent_ids) {
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
        msgStmt.insert.run(msg);
        const delivered = pushToAgent(to, { event: "new_message", message: { ...msg, metadata } });
        if (delivered) msgStmt.markDelivered.run(msg.id);
        results[to] = delivered;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ broadcast: true, delivery_status: results }, null, 2),
        }],
      };
    }
  );

  // ────────────────────────────────────────────────────
  // Tool 6: get_online_agents
  // 查询当前在线的 Agent 列表
  // ────────────────────────────────────────────────────
  server.tool(
    "get_online_agents",
    "查询当前通过 SSE 在线连接的 Agent 列表，分配任务前可先确认对方在线。",
    {},
    async () => {
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
}
