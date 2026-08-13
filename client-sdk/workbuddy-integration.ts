/**
 * workbuddy-integration.ts
 * WorkBuddy 侧接入示例（Feature A：AgentRuntime 自主执行闭环）
 *
 * 本文件展示 WorkBuddy 如何：
 *  1. 连接 Hub（一行代码）
 *  2. 用 AgentRuntime 包裹 AgentClient，收到任务后自动：
 *     in_progress → 执行 executeWorkBuddyTask → completed/failed
 *  3. execute 内演示 requestAuthorization：敏感操作先征求人类授权
 *  4. 处理 Hermes 发来的协作消息 / 委托任务的进度更新
 */
import { AgentClient, type TaskEvent, AuthorizationRejected, AuthorizationExpired } from "../client-sdk/agent-client.js";
import { runAutonomousLoop, type AgentRuntime } from "../client-sdk/runtime.js";

// ─── 1. 创建 WorkBuddy 客户端 ──────────────────────────
const workbuddy = new AgentClient({
  agentId: "workbuddy",
  hubUrl:  process.env.HUB_URL ?? "http://localhost:3100",
  // ⚠️ 不再在 opts 里写 onTaskAssigned —— 由 AgentRuntime 接管闭环
  //    若同时设置 onTaskAssigned，会与 AgentRuntime 重复执行，务必二选一。

  // ── 收到普通消息 ──────────────────────────────────────
  onMessage: async (msg) => {
    console.log(`\n[WorkBuddy] 💬 来自 ${msg.from_agent}: ${msg.content}`);
    if (msg.content.includes("确认")) {
      await workbuddy.sendMessage(msg.from_agent, "已确认，WorkBuddy 收到。");
    }
  },

  // ── 任务进度回调（自己发出去的任务被执行时触发）─────────
  onTaskUpdated: async (upd) => {
    const icon = upd.status === "completed" ? "✅" : upd.status === "failed" ? "❌" : "⏳";
    console.log(`\n[WorkBuddy] ${icon} 任务 ${upd.task_id} 进度更新`);
    console.log(`  状态: ${upd.status}  进度: ${upd.progress}%`);
    if (upd.result) console.log(`  结果: ${upd.result}`);
  },
});

// ─── 2. 任务执行逻辑（宿主注入 AgentRuntime）──────────
async function executeWorkBuddyTask(task: TaskEvent): Promise<string> {
  // 演示 requestAuthorization：遇到敏感操作（删除/撤销/外邮/付费等）先征求人类授权。
  // 若人类拒绝 / 超时，requestAuthorization 会抛 AuthorizationRejected / AuthorizationExpired，
  // AgentRuntime 捕获后标记任务 failed 且不执行该敏感操作（优雅中止）。
  const sensitive = /删除|撤销|发送外部邮件|付费|revoke|delete|cancel/i.test(task.description);
  if (sensitive) {
    await runtime.requestAuthorization({
      type: "delete_data",
      description: `WorkBuddy 拟执行敏感操作: ${task.description}`,
      payload: { description: task.description, priority: task.priority },
      taskId: task.id,
    });
  }

  // ── 在这里放 WorkBuddy 的实际执行逻辑 ──────────────
  console.log(`\n[WorkBuddy] 📋 执行任务 ${task.id}: ${task.description}`);
  await new Promise(r => setTimeout(r, 2000)); // 模拟执行耗时
  return `WorkBuddy 执行完成: ${task.description.slice(0, 50)}...`;
}

// ─── 3. 用 AgentRuntime 包裹，获得自主执行能力 ─────────
const runtime: AgentRuntime = runAutonomousLoop(workbuddy, executeWorkBuddyTask, {
  maxConcurrent: 4,
  requeueIncomplete: true,
  onError: (taskId, err) => {
    if (err instanceof AuthorizationRejected) {
      console.error(`[WorkBuddy] ⛔ 任务 ${taskId} 因授权被拒中止: ${err.message}`);
    } else if (err instanceof AuthorizationExpired) {
      console.error(`[WorkBuddy] ⏰ 任务 ${taskId} 因授权过期中止: ${err.message}`);
    } else {
      console.error(`[WorkBuddy] ❌ 任务 ${taskId} 出错:`, err);
    }
  },
});

// ─── 4. 启动 ───────────────────────────────────────────
workbuddy.start();
runtime.start();

// ─── 5. 示例：向 Hermes 分配任务 ──────────────────────
async function runDemo() {
  await new Promise(r => setTimeout(r, 1000)); // 等待连接稳定

  const online = await workbuddy.getOnlineAgents();
  console.log("\n[WorkBuddy] 当前在线 Agents:", online);

  if (online.includes("hermes")) {
    const result = await workbuddy.assignTask(
      "hermes",
      "请分析最近 7 天辽宁省媒体融合相关新闻，提取关键事件并按重要性排序，输出 Markdown 格式报告",
      "重点关注：辽望客户端、北斗融媒、省级媒体政策。输出结构：摘要 + 事件列表 + 趋势分析",
      "high"
    );
    console.log("\n[WorkBuddy] 任务已分配:", result);
  } else {
    console.log("[WorkBuddy] Hermes 不在线，任务将在其上线后自动推送");
    await workbuddy.assignTask(
      "hermes",
      "这是一条离线任务，Hermes 上线后会自动收到并执行",
      "",
      "normal"
    );
  }
}

runDemo().catch(console.error);

export { workbuddy, runtime };
