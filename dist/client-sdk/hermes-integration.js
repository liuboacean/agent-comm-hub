/**
 * hermes-integration.ts
 * Hermes 侧接入（Feature A：AgentRuntime 自主执行闭环）
 *
 * Hermes 启动后会自动：
 *  - 连接 Hub 的 SSE 端点
 *  - 用 AgentRuntime 包裹 HostTaskBridge，收到任务后自主执行（无需人工干预）
 *  - 汇报执行进度和结果
 *  - bridge 内置敏感操作授权挂起（Feature B：人类在环）
 *  - 断线后 AgentClient 自动重连
 *
 * 关键变更（v3.0.23）：把原先的「setTimeout 模拟执行」替换为
 *   AbstractHostTaskBridge —— 真实执行逻辑收敛到 HermesTaskBridge.runTask()
 *   这一个 override 点，进度回报与授权判定由基类统一处理。
 */
import { AgentClient, AuthorizationRejected, AuthorizationExpired, } from "../client-sdk/agent-client.js";
import { runAutonomousLoop } from "../client-sdk/runtime.js";
import { AbstractHostTaskBridge, } from "./adapters/host-task-bridge.js";
const HERMES_ID = process.env.HERMES_ID ?? "hermes";
const HUB_URL = process.env.HUB_URL ?? "http://localhost:3100";
// ─── 1. 创建 Hermes 客户端 ─────────────────────────────
const hermes = new AgentClient({
    agentId: HERMES_ID,
    hubUrl: HUB_URL,
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
// ─── 2. 宿主执行桥：真实逻辑收敛到 runTask() ───────────
/**
 * Hermes 的任务执行桥。
 * 基类已处理：敏感操作授权挂起 + 进度骨架（10% 起点）。
 * 这里只实现「Hermes 到底怎么干活」—— runTask 把任务交给注入的 HostExecutor。
 */
class HermesTaskBridge extends AbstractHostTaskBridge {
    /**
     * ★ 宿主真实执行 ★
     * 不再使用 setTimeout 占位。runTask 把任务交给注入的 HostExecutor
     * （默认 defaultHostExecutor()：有 HOST_EXEC_ENDPOINT 走 HTTP，否则走 LLM）。
     * Hermes 作为宿主，默认通过 LLM 直接产出结果，实现「任务到达 → 自动干活」。
     * 想接 Hermes 宿主真实运行时，构造时传入自定义 HostExecutor 即可：
     *   new HermesTaskBridge({ client, requestAuth, executor: myExecutor })
     */
    async runTask(task, report) {
        report(30, "解析任务并规划");
        report(50, "调用宿主执行器");
        const output = await this.executor.execute(task, report);
        report(90, "汇总结果");
        return output;
    }
}
// ─── 3. 用 AgentRuntime 包裹，获得自主执行能力 ─────────
let runtime;
const bridge = new HermesTaskBridge({
    client: hermes,
    requestAuth: (op) => runtime.requestAuthorization(op),
});
runtime = runAutonomousLoop(hermes, (task) => bridge.execute(task), {
    maxConcurrent: 4,
    requeueIncomplete: true,
    onSelfMessage: async (msg) => {
        console.log(`\n[Hermes] 🪞 收到指向自己的消息: ${msg.content}`);
    },
    onError: (taskId, err) => {
        if (err instanceof AuthorizationRejected) {
            console.error(`[Hermes] ⛔ 任务 ${taskId} 因授权被拒中止: ${err.message}`);
        }
        else if (err instanceof AuthorizationExpired) {
            console.error(`[Hermes] ⏰ 任务 ${taskId} 因授权过期中止: ${err.message}`);
        }
        else {
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
async function handleHermesMessage(msg) {
    if (msg.content.includes("你好")) {
        await hermes.sendMessage(msg.from_agent, "你好！Hermes 在线，随时待命。");
    }
}
// ─── 处理收到的任务结果 ────────────────────────────────
async function processTaskResult(taskId, result) {
    console.log(`[Hermes] 处理任务 ${taskId} 的结果...`);
}
export { hermes, runtime, bridge };
//# sourceMappingURL=hermes-integration.js.map