/**
 * host-task-bridge.ts — 宿主任务执行桥（Host Task Bridge）
 * ------------------------------------------------------------------
 * 解决的问题：
 *   AgentRuntime 只负责「状态机 + 护栏」（inFlight 去重 / 并发上限 /
 *   崩溃恢复 / 防自杀循环 / 授权挂起），它**不关心宿主如何真正干活**。
 *
 *   把「宿主怎么完成任务」抽象成 HostTaskBridge，任何宿主
 *   （WorkBuddy / Hermes / 你自己的 Agent）只要实现 runTask() 一个方法，
 *   即可接入自主执行闭环，无需重复编写进度回报、授权判定等样板。
 *
 * 设计要点：
 *   - execute() 由 AgentRuntime 调用，返回结果字符串 → 自动回写 completed。
 *   - 内置：敏感操作授权挂起（Feature B）+ 进度骨架（10% 起点）。
 *   - runTask(task, report) 是宿主**唯一**需要实现的钩子；report 用于
 *     实时回报百分比与文案。宿主在这里接入自己的真实能力
 *     （LLM 调用 / MCP 工具 / 脚本 / 外部 API）。
 *
 * 参见：client-sdk/workbuddy-integration.ts、client-sdk/hermes-integration.ts
 */
import { AuthorizationRejected, AuthorizationExpired, } from "../agent-client.js";
import { defaultHostExecutor } from "./host-executor.js";
/** 抽象基类：内置授权挂起 + 进度骨架，宿主只需实现 runTask() */
export class AbstractHostTaskBridge {
    client;
    /** 授权请求函数：由宿主注入，内部转发到 AgentRuntime.requestAuthorization */
    requestAuth;
    /** 宿主执行器：真实干活的能力（LLM / HTTP / 自定义）。由宿主注入。 */
    executor;
    /** 敏感操作判定正则（命中即走授权流程） */
    sensitivePattern;
    /** 命中的敏感操作类目（写入 auth_requests.type，见 types.ts AUTH_OP_TYPES） */
    sensitiveOpType;
    constructor(opts) {
        this.client = opts.client;
        this.requestAuth = opts.requestAuth;
        this.executor = opts.executor ?? defaultHostExecutor();
        this.sensitivePattern =
            opts.sensitivePattern ??
                /删除|撤销|发送外部邮件|付费|revoke|delete|cancel|schema|drop|truncate/i;
        this.sensitiveOpType = opts.sensitiveOpType ?? "delete_data";
    }
    async execute(task) {
        // 1. 敏感操作先征求人类授权（Feature B）。
        //    人类拒绝 / 超时 → requestAuthorization 抛 AuthorizationRejected /
        //    AuthorizationExpired → AgentRuntime 捕获后标记 failed 并优雅中止。
        if (this.sensitivePattern.test(task.description)) {
            await this.requestAuth({
                type: this.sensitiveOpType,
                description: `宿主拟执行敏感操作: ${task.description}`,
                payload: {
                    description: task.description,
                    priority: task.priority,
                    context: task.context,
                },
                taskId: task.id,
            });
        }
        // 2. 进度骨架：标记已接收（10%），真正细分交给宿主 runTask。
        await this.client.updateTaskStatus(task.id, "in_progress", "任务已接收，开始执行", 10);
        const report = (progress, message) => this.client.updateTaskStatus(task.id, "in_progress", message, progress);
        // 3. 真正的宿主逻辑（override 点）。
        return await this.runTask(task, report);
    }
}
export { AuthorizationRejected, AuthorizationExpired };
//# sourceMappingURL=host-task-bridge.js.map