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
import { AgentClient, type TaskEvent } from "../client-sdk/agent-client.js";
import { type AgentRuntime } from "../client-sdk/runtime.js";
import { AbstractHostTaskBridge, type ProgressReporter } from "./adapters/host-task-bridge.js";
declare const hermes: AgentClient;
/**
 * Hermes 的任务执行桥。
 * 基类已处理：敏感操作授权挂起 + 进度骨架（10% 起点）。
 * 这里只实现「Hermes 到底怎么干活」—— runTask 把任务交给注入的 HostExecutor。
 */
declare class HermesTaskBridge extends AbstractHostTaskBridge {
    /**
     * ★ 宿主真实执行 ★
     * 不再使用 setTimeout 占位。runTask 把任务交给注入的 HostExecutor
     * （默认 defaultHostExecutor()：有 HOST_EXEC_ENDPOINT 走 HTTP，否则走 LLM）。
     * Hermes 作为宿主，默认通过 LLM 直接产出结果，实现「任务到达 → 自动干活」。
     * 想接 Hermes 宿主真实运行时，构造时传入自定义 HostExecutor 即可：
     *   new HermesTaskBridge({ client, requestAuth, executor: myExecutor })
     */
    protected runTask(task: TaskEvent, report: ProgressReporter): Promise<string>;
}
declare let runtime: AgentRuntime;
declare const bridge: HermesTaskBridge;
export { hermes, runtime, bridge };
