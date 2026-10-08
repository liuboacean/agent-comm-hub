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
import { AgentClient, type TaskEvent } from "../client-sdk/agent-client.js";
import { type AgentRuntime } from "../client-sdk/runtime.js";
import { AbstractHostTaskBridge, type ProgressReporter } from "./adapters/host-task-bridge.js";
declare const workbuddy: AgentClient;
/**
 * WorkBuddy 的任务执行桥。
 * 基类已处理：敏感操作授权挂起 + 进度骨架（10% 起点）。
 * 这里只实现「宿主到底怎么干活」—— runTask 把任务交给注入的 HostExecutor。
 */
declare class WorkBuddyTaskBridge extends AbstractHostTaskBridge {
    /** 解析任务意图（轻量预处理，用于进度文案，不影响执行） */
    private parseIntent;
    /**
     * ★ 宿主真实执行 ★
     * 不再使用 setTimeout 占位。runTask 把任务交给注入的 HostExecutor
     * （默认 defaultHostExecutor()：有 HOST_EXEC_ENDPOINT 走 HTTP，否则走 LLM）。
     * 想接 WorkBuddy 宿主真实运行时，构造时传入自定义 HostExecutor 即可：
     *   new WorkBuddyTaskBridge({ client, requestAuth, executor: myExecutor })
     */
    protected runTask(task: TaskEvent, report: ProgressReporter): Promise<string>;
}
declare let runtime: AgentRuntime;
declare const bridge: WorkBuddyTaskBridge;
export { workbuddy, runtime, bridge };
