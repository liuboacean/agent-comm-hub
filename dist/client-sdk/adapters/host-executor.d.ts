/**
 * host-executor.ts — 宿主执行器（Host Executor）
 * ------------------------------------------------------------------
 * 这是「宿主到底怎么干活」的契约与参考实现。
 *
 * 背景：Feature A 的 AgentRuntime 只负责状态机 + 护栏，宿主的真实能力
 * 通过一个 HostExecutor 注入。之前 WorkBuddy/Hermes 桥里是 setTimeout
 * 占位回显；本文件把它换成**真实可运行**的执行器，使「任务派发 →
 * Agent 自动调用宿主能力 → 回写结果」真正闭环。
 *
 * 两个开箱即用的参考实现：
 *   - LlmHostExecutor  : 直接调 LLM（Anthropic / OpenAI 兼容），
 *                        配置 HOST_LLM_* 环境变量即可工作。
 *   - HttpHostExecutor : 调宿主自身暴露的 HTTP 任务端点（适配 Hermes
 *                        这类自带 API 的宿主）。
 *
 * 你也可以实现自己的 HostExecutor（比如接 WorkBuddy/Hermes 的内部
 * 运行时、MCP 工具、脚本引擎），只要满足 HostExecutor 接口即可。
 */
import type { TaskEvent } from "../agent-client.js";
import type { ProgressReporter, HostExecutor } from "./host-task-bridge.js";
export type LlmProvider = "anthropic" | "openai";
export interface LlmHostExecutorOptions {
    provider?: LlmProvider;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    systemPrompt?: string;
    timeoutMs?: number;
}
export declare class LlmHostExecutor implements HostExecutor {
    private readonly provider;
    private readonly baseUrl;
    private readonly apiKey;
    private readonly model;
    private readonly systemPrompt;
    private readonly timeoutMs;
    constructor(opts?: LlmHostExecutorOptions);
    execute(task: TaskEvent, report: ProgressReporter): Promise<string>;
    private buildHeaders;
    private buildBody;
    private extractText;
}
export interface HttpHostExecutorOptions {
    endpoint?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}
export declare class HttpHostExecutor implements HostExecutor {
    private readonly endpoint;
    private readonly headers;
    private readonly timeoutMs;
    constructor(opts?: HttpHostExecutorOptions);
    execute(task: TaskEvent, report: ProgressReporter): Promise<string>;
}
/**
 * 按优先级选择默认执行器：
 *   1. 配置了 HOST_EXEC_ENDPOINT → HttpHostExecutor（宿主自带 API，如 Hermes）
 *   2. 否则 → LlmHostExecutor（需要 HOST_LLM_API_KEY）
 */
export declare function defaultHostExecutor(): HostExecutor;
