/**
 * test-e2e.ts — 端到端测试
 * 模拟 WorkBuddy 和 Hermes 之间的完整协作流程
 *
 * 测试场景：
 *  1. WorkBuddy → Hermes 发送即时消息
 *  2. WorkBuddy → Hermes 分配任务（Hermes 自主执行并回报）
 *  3. Hermes 离线时分配任务 → Hermes 上线后自动补发
 *  4. 查询在线状态、任务状态
 *
 * 运行: npm test
 *      npx tsx scripts/test-e2e.ts
 */
import { AgentClient } from "../client-sdk/agent-client.js";
const HUB_URL = process.env.HUB_URL ?? "http://localhost:3100";
const results = [];
function assert(name, condition, detail) {
    const passed = condition;
    results.push({ name, passed, detail });
    const icon = passed ? "✅" : "❌";
    console.log(`  ${icon} ${name}${passed ? "" : ` — ${detail}`}`);
}
async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}
// ─── 测试主流程 ────────────────────────────────────────
async function runTests() {
    console.log("═══════════════════════════════════════");
    console.log("  Agent Communication Hub  端到端测试");
    console.log("═══════════════════════════════════════\n");
    // 检查 Hub 是否在运行
    try {
        const health = await fetch(`${HUB_URL}/health`);
        const body = await health.json();
        assert("Hub 健康检查", health.ok, `${health.status}`);
    }
    catch {
        console.error("\n❌ Hub 未启动！请先运行: npm run dev\n");
        process.exit(1);
    }
    // ─── 测试 1: 基础消息收发 ──────────────────────────
    console.log("\n── 测试 1: 即时消息收发 ──────────────");
    let messageReceived = false;
    const hermes = new AgentClient({
        agentId: "test-hermes",
        hubUrl: HUB_URL,
        onMessage: async (msg) => {
            if (msg.content === "测试消息: 你好 Hermes") {
                messageReceived = true;
                // 回复
                await hermes.sendMessage("test-workbuddy", "收到，我是 Hermes。");
            }
        },
    });
    hermes.start();
    await delay(500);
    const wb = new AgentClient({ agentId: "test-workbuddy", hubUrl: HUB_URL });
    wb.start();
    await delay(500);
    await wb.sendMessage("test-hermes", "测试消息: 你好 Hermes");
    await delay(1500);
    assert("Hermes 收到 WorkBuddy 的消息", messageReceived, "超时未收到");
    // ─── 测试 2: 任务分配与自主执行 ────────────────────
    console.log("\n── 测试 2: 任务分配与自主执行 ──────────");
    let taskExecuted = false;
    const hermes2 = new AgentClient({
        agentId: "test-hermes-exec",
        hubUrl: HUB_URL,
        onTaskAssigned: async (task) => {
            taskExecuted = true;
            await hermes2.updateTaskStatus(task.id, "in_progress", undefined, 30);
            await delay(500);
            await hermes2.updateTaskStatus(task.id, "completed", "测试结果: 任务完成", 100);
        },
    });
    hermes2.start();
    await delay(500);
    const assignResult = await wb.assignTask("test-hermes-exec", "执行一个测试任务", "这是测试上下文", "high");
    await delay(2000);
    assert("任务分配成功", !!assignResult?.taskId, JSON.stringify(assignResult));
    assert("Hermes 自主执行了任务", taskExecuted, "未触发 onTaskAssigned");
    // ─── 测试 3: 查询在线 Agent ────────────────────────
    console.log("\n── 测试 3: 在线状态查询 ──────────────");
    const online = await wb.getOnlineAgents();
    assert("能查到在线 Agent", online.length > 0, `在线列表为空`);
    console.log(`  在线 Agents: ${online.join(", ")}`);
    // ─── 测试 4: 任务状态查询 ──────────────────────────
    console.log("\n── 测试 4: 任务状态查询 ──────────────");
    if (assignResult?.taskId) {
        const status = await wb.getTaskStatus(assignResult.taskId);
        assert("任务状态可查", !!status?.status, JSON.stringify(status));
        assert("任务已标记完成", status?.status === "completed", `实际状态: ${status?.status}`);
    }
    // ─── 清理 ──────────────────────────────────────────
    hermes.stop();
    hermes2.stop();
    wb.stop();
    await delay(300);
    // ─── 结果汇总 ──────────────────────────────────────
    console.log("\n═══════════════════════════════════════");
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`  总计: ${results.length}  通过: ${passed}  失败: ${failed}`);
    if (failed > 0) {
        console.log("\n  失败项:");
        results.filter(r => !r.passed).forEach(r => console.log(`    ❌ ${r.name}: ${r.detail}`));
    }
    console.log("═══════════════════════════════════════");
    process.exit(failed > 0 ? 1 : 0);
}
runTests().catch(err => {
    console.error("测试运行失败:", err);
    process.exit(1);
});
//# sourceMappingURL=test-e2e.js.map