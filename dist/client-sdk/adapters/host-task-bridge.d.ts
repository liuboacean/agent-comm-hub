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
import { AgentClient, type TaskEvent, AuthorizationRejected, AuthorizationExpired } from "../agent-client.js";
import type { SensitiveOp } from "../agent-client.js";
/** 进度回调：宿主在 runTask 内部用它实时回报百分比与文案 */
export type ProgressReporter = (progress: number, message?: string) => Promise<void>;
/**
 * 宿主执行器契约：宿主「到底怎么干活」的统一抽象。
 * AgentRuntime 不关心具体实现，宿主注入一个 HostExecutor 即可。
 * 参考实现见 client-sdk/adapters/host-executor.ts
 * （LlmHostExecutor / HttpHostExecutor / defaultHostExecutor）。
 */
export interface HostExecutor {
    execute(task: TaskEvent, report: ProgressReporter): Promise<string>;
}
/**
 * 宿主任务执行桥接口。
 * AgentRuntime 把任务交给 bridge.execute()，宿主只需关心 runTask()。
 */
export interface HostTaskBridge {
    /** 由 AgentRuntime 调用：返回任务结果字符串（会被回写为 completed） */
    execute(task: TaskEvent): Promise<string>;
}
/** 抽象基类：内置授权挂起 + 进度骨架，宿主只需实现 runTask() */
export declare abstract class AbstractHostTaskBridge implements HostTaskBridge {
    protected client: AgentClient;
    /** 授权请求函数：由宿主注入，内部转发到 AgentRuntime.requestAuthorization */
    protected requestAuth: (op: SensitiveOp) => Promise<void>;
    /** 宿主执行器：真实干活的能力（LLM / HTTP / 自定义）。由宿主注入。 */
    protected executor: HostExecutor;
    /** 敏感操作判定正则（命中即走授权流程） */
    protected sensitivePattern: RegExp;
    /** 命中的敏感操作类目（写入 auth_requests.type，见 types.ts AUTH_OP_TYPES） */
    protected sensitiveOpType: string;
    constructor(opts: {
        client: AgentClient;
        /** (op) => runtime.requestAuthorization(op) —— 必须能拿到 AgentRuntime 引用 */
        requestAuth: (op: SensitiveOp) => Promise<void>;
        /** 宿主执行器：真实干活的能力。不传则使用 defaultHostExecutor()（按环境变量选 LLM/HTTP） */
        executor?: HostExecutor;
        sensitivePattern?: RegExp;
        sensitiveOpType?: string;
    });
    execute(task: TaskEvent): Promise<string>;
    /**
     * 宿主唯一需要实现的钩子：
     *   拿到任务 + 进度回调，返回结果字符串。
     *
     * 在这里接入宿主的真实能力：
     *   - 调 LLM（如 Claude / GPT）做规划与生成
     *   - 调用 MCP 工具 / 外部 API / 数据库 / 运行脚本
     *   - 通过 report(p, msg) 在关键阶段回报进度
     */
    protected abstract runTask(task: TaskEvent, report: ProgressReporter): Promise<string>;
}
export { AuthorizationRejected, AuthorizationExpired };
