/**
 * workbuddy-integration.ts
 * WorkBuddy 侧接入（Feature A：AgentRuntime 自主执行闭环）
 *
 * 本文件展示 WorkBuddy 如何：
 *  1. 连接 Hub（一行代码 new AgentClient）
 *  2. 用 AgentRuntime 包裹一个 HostTaskBridge，收到任务后自动：
 *     in_progress → bridge.execute() → completed/failed
 *  3. bridge 内置敏感操作授权挂起（Feature B：人类在环）
 *  4. 处理其它 Agent 发来的协作消息 / 委托任务的进度更新
 *
 * 关键变更（v3.0.23）：把原先的「setTimeout 模拟执行」替换为
 *   AbstractHostTaskBridge —— 真实执行逻辑收敛到 WorkBuddyTaskBridge.runTask()
 *   这一个 override 点，进度回报与授权判定由基类统一处理。
 */
import { AgentClient, AuthorizationRejected, AuthorizationExpired, } from "../client-sdk/agent-client.js";
import { runAutonomousLoop } from "../client-sdk/runtime.js";
import { AbstractHostTaskBridge, } from "./adapters/host-task-bridge.js";
// ─── 1. 创建 WorkBuddy 客户端 ──────────────────────────
const workbuddy = new AgentClient({
    agentId: "workbuddy",
    hubUrl: process.env.HUB_URL ?? "http://localhost:3100",
    // ⚠️ 不再在 opts 里写 onTaskAssigned —— 由 AgentRuntime 接管闭环。
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
        if (upd.result)
            console.log(`  结果: ${upd.result}`);
    },
});
// ─── 2. 宿主执行桥：真实逻辑收敛到 runTask() ───────────
/**
 * WorkBuddy 的任务执行桥。
 * 基类已处理：敏感操作授权挂起 + 进度骨架（10% 起点）。
 * 这里只实现「宿主到底怎么干活」—— runTask 把任务交给注入的 HostExecutor。
 */
class WorkBuddyTaskBridge extends AbstractHostTaskBridge {
    /** 解析任务意图（轻量预处理，用于进度文案，不影响执行） */
    parseIntent(task) {
        const d = task.description.toLowerCase();
        let domain = "general";
        if (/新闻|舆情|媒体|资讯/.test(d))
            domain = "media-monitor";
        else if (/代码|bug|重构|测试/.test(d))
            domain = "engineering";
        else if (/数据|报表|分析|统计/.test(d))
            domain = "data-analysis";
        const action = /分析|总结|提取/.test(d) ? "analyze" : /生成|写|创作/.test(d) ? "generate" : "execute";
        return { domain, action };
    }
    /**
     * ★ 宿主真实执行 ★
     * 不再使用 setTimeout 占位。runTask 把任务交给注入的 HostExecutor
     * （默认 defaultHostExecutor()：有 HOST_EXEC_ENDPOINT 走 HTTP，否则走 LLM）。
     * 想接 WorkBuddy 宿主真实运行时，构造时传入自定义 HostExecutor 即可：
     *   new WorkBuddyTaskBridge({ client, requestAuth, executor: myExecutor })
     */
    async runTask(task, report) {
        const intent = this.parseIntent(task);
        report(25, `意图识别: ${intent.domain} / ${intent.action}`);
        report(50, "调用宿主执行器");
        const output = await this.executor.execute(task, report);
        report(90, "汇总结果");
        return output;
    }
}
// ─── 3. 用 AgentRuntime 包裹，获得自主执行能力 ─────────
// runtime 需在 bridge 之前声明，因为 requestAuth 闭包要引用它。
let runtime;
const bridge = new WorkBuddyTaskBridge({
    client: workbuddy,
    // 授权请求转发到 AgentRuntime（Feature B 的实际挂起点）
    requestAuth: (op) => runtime.requestAuthorization(op),
});
runtime = runAutonomousLoop(workbuddy, (task) => bridge.execute(task), {
    maxConcurrent: 4,
    requeueIncomplete: true,
    onError: (taskId, err) => {
        if (err instanceof AuthorizationRejected) {
            console.error(`[WorkBuddy] ⛔ 任务 ${taskId} 因授权被拒中止: ${err.message}`);
        }
        else if (err instanceof AuthorizationExpired) {
            console.error(`[WorkBuddy] ⏰ 任务 ${taskId} 因授权过期中止: ${err.message}`);
        }
        else {
            console.error(`[WorkBuddy] ❌ 任务 ${taskId} 出错:`, err);
        }
    },
});
// ─── 4. 启动 ───────────────────────────────────────────
workbuddy.start();
runtime.start();
console.log(`[WorkBuddy] 已启动，Agent ID: workbuddy`);
console.log(`[WorkBuddy] 正在连接 Hub: ${process.env.HUB_URL ?? "http://localhost:3100"}`);
// ─── 5. 示例：向 Hermes 分配任务 ──────────────────────
async function runDemo() {
    await new Promise((r) => setTimeout(r, 1000)); // 等待连接稳定
    const online = await workbuddy.getOnlineAgents();
    console.log("\n[WorkBuddy] 当前在线 Agents:", online);
    if (online.includes("hermes")) {
        const result = await workbuddy.assignTask("hermes", "请分析最近 7 天辽宁省媒体融合相关新闻，提取关键事件并按重要性排序，输出 Markdown 格式报告", "重点关注：辽望客户端、北斗融媒、省级媒体政策。输出结构：摘要 + 事件列表 + 趋势分析", "high");
        console.log("\n[WorkBuddy] 任务已分配:", result);
    }
    else {
        console.log("[WorkBuddy] Hermes 不在线，任务将在其上线后自动推送");
        await workbuddy.assignTask("hermes", "这是一条离线任务，Hermes 上线后会自动收到并执行", "", "normal");
    }
}
runDemo().catch(console.error);
export { workbuddy, runtime, bridge };
//# sourceMappingURL=workbuddy-integration.js.map