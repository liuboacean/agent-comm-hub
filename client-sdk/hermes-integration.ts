/**
 * hermes-integration.ts
 * Hermes 侧接入示例（Feature A：AgentRuntime 自主执行闭环）
 *
 * Hermes 启动后会自动：
 *  - 连接 Hub 的 SSE 端点
 *  - 用 AgentRuntime 包裹 AgentClient，收到任务后自主执行（无需人工干预）
 *  - 汇报执行进度和结果
 *  - execute 内演示 requestAuthorization：敏感操作先征求人类授权
 *  - 断线后自动重连
 */
import { AgentClient, type TaskEvent, type MessageEvent, AuthorizationRejected, AuthorizationExpired } from "../client-sdk/agent-client.js";
import { runAutonomousLoop, type AgentRuntime } from "../client-sdk/runtime.js";

const HERMES_ID = process.env.HERMES_ID ?? "hermes";
const HUB_URL   = process.env.HUB_URL   ?? "http://localhost:3100";

// ─── 1. 创建 Hermes 客户端 ─────────────────────────────
const hermes = new AgentClient({
  agentId: HERMES_ID,
  hubUrl:  HUB_URL,
  // ⚠️ 不再在 opts 里写 onTaskAssigned —— 由 AgentRuntime 接管闭环

  // ── 收到普通消息 ───────────────────────────────────
  onMessage: async (msg) => {
    console.log(`\n[Hermes] 💬 来自 ${msg.from_agent}: ${msg.content}`);
    if (msg.type === "ack") {
      console.log(`[Hermes] 收到确认消息，无需回复`);
      return;
    }
    await handleHermesMessage(msg);
  },

  // ── 收到任务进度更新（自己委托给别人的任务）────────────
  onTaskUpdated: async (upd) => {
    const icon = upd.status === "completed" ? "✅" : upd.status === "failed" ? "❌" : "⏳";
    console.log(`\n[Hermes] ${icon} 委托任务进度: ${upd.task_id}`);
    console.log(`  状态: ${upd.status}  进度: ${upd.progress}%`);
    if (upd.result) {
      await processTaskResult(upd.task_id, upd.result);
    }
  },
});

// ─── 2. 任务执行核心逻辑（宿主注入 AgentRuntime）──────────
async function executeHermesTask(task: TaskEvent): Promise<string> {
  const { description, context, id } = task;

  // 演示 requestAuthorization：遇到敏感操作先征求人类授权。
  // 若人类拒绝 / 超时，抛 AuthorizationRejected / AuthorizationExpired，任务标记 failed 并优雅中止。
  const sensitive = /删除|撤销|发送外部邮件|付费|revoke|delete|cancel|schema/i.test(description);
  if (sensitive) {
    await runtime.requestAuthorization({
      type: "delete_data",
      description: `Hermes 拟执行敏感操作: ${description}`,
      payload: { description, context },
      taskId: id,
    });
  }

  // ── 中途汇报进度示例 ───────────────────────────────
  await hermes.updateTaskStatus(id, "in_progress", "正在收集数据...", 20);

  // TODO: 在这里对接 Hermes 的实际能力：
  //  - 调用 LLM（如 Claude API）/ 执行 MCP 工具 / 访问数据库或外部 API / 运行脚本
  await new Promise(r => setTimeout(r, 1500));
  await hermes.updateTaskStatus(id, "in_progress", "正在分析处理...", 60);

  await new Promise(r => setTimeout(r, 1500));
  await hermes.updateTaskStatus(id, "in_progress", "正在生成报告...", 90);

  await new Promise(r => setTimeout(r, 500));

  return JSON.stringify({
    summary:  `Hermes 完成了任务：${description.slice(0, 80)}`,
    data:     { processed: true, context },
    timestamp: new Date().toISOString(),
  }, null, 2);
}

// ─── 3. 用 AgentRuntime 包裹，获得自主执行能力 ─────────
const runtime: AgentRuntime = runAutonomousLoop(hermes, executeHermesTask, {
  maxConcurrent: 4,
  requeueIncomplete: true,
  // 可选：指向自己的 new_message 反应
  onSelfMessage: async (msg: MessageEvent) => {
    console.log(`\n[Hermes] 🪞 收到指向自己的消息: ${msg.content}`);
  },
  onError: (taskId, err) => {
    if (err instanceof AuthorizationRejected) {
      console.error(`[Hermes] ⛔ 任务 ${taskId} 因授权被拒中止: ${err.message}`);
    } else if (err instanceof AuthorizationExpired) {
      console.error(`[Hermes] ⏰ 任务 ${taskId} 因授权过期中止: ${err.message}`);
    } else {
      console.error(`[Hermes] ❌ 任务 ${taskId} 出错:`, err);
    }
  },
});

// ─── 4. 启动 ───────────────────────────────────────────
hermes.start();
runtime.start();
console.log(`[Hermes] 已启动，Agent ID: ${HERMES_ID}`);
console.log(`[Hermes] 正在连接 Hub: ${HUB_URL}`);

// ─── 消息处理逻辑 ──────────────────────────────────────
async function handleHermesMessage(msg: MessageEvent): Promise<void> {
  if (msg.content.includes("你好")) {
    await hermes.sendMessage(msg.from_agent, "你好！Hermes 在线，随时待命。");
  }
}

// ─── 处理收到的任务结果 ────────────────────────────────
async function processTaskResult(taskId: string, result: string): Promise<void> {
  console.log(`[Hermes] 处理任务 ${taskId} 的结果...`);
}

export { hermes, runtime };
