# 宿主接入指南（Host Integration）

> 版本：v3.0.23 ｜ 关联特性：Feature A（AgentRuntime 自主执行闭环）、Feature B（人类在环授权 HITL）

本文说明任意宿主（WorkBuddy / Hermes / 你自己的 Agent）如何接入 **agent-comm-hub**，
让 Agent 收到任务后**自动**执行并回写结果，无需人工中转。

---

## 1. 核心思想

`AgentRuntime` 只负责**状态机 + 护栏**，不关心宿主如何真正完成任务：

| 职责 | 由谁负责 |
|------|---------|
| `in_progress → execute() → completed/failed` 状态机 | `AgentRuntime` |
| 幂等去重 / 并发上限 / 崩溃恢复 / 防自杀循环 | `AgentRuntime` |
| 敏感操作授权挂起（Feature B） | `AgentRuntime.requestAuthorization` |
| **宿主到底怎么干活** | `HostTaskBridge.runTask()` ← 你来实现 |

把所有「宿主专属」的逻辑收敛到 **一个 override 点** `runTask()`，
进度回报与授权判定由 `AbstractHostTaskBridge` 统一处理。

---

## 2. 最小接入（4 步）

```ts
import { AgentClient } from "../client-sdk/agent-client.js";
import { runAutonomousLoop, type AgentRuntime } from "../client-sdk/runtime.js";
import { AbstractHostTaskBridge, type ProgressReporter } from "./adapters/host-task-bridge.js";

// ① 创建客户端
const client = new AgentClient({ agentId: "my-host", hubUrl: "http://localhost:3100" });

// ② 实现你的执行桥（只写 runTask）
class MyBridge extends AbstractHostTaskBridge {
  protected async runTask(task, report: ProgressReporter): Promise<string> {
    report(30, "解析任务");
    const out = await myRealExecutor(task);   // ← 接入宿主真实能力
    report(90, "汇总");
    return JSON.stringify(out);
  }
}

// ③ 用 AgentRuntime 包裹（runtime 需先声明，供 requestAuth 闭包引用）
let runtime: AgentRuntime;
const bridge = new MyBridge({ client, requestAuth: (op) => runtime.requestAuthorization(op) });
runtime = runAutonomousLoop(client, (t) => bridge.execute(t), { maxConcurrent: 4 });

// ④ 启动
client.start();
runtime.start();
```

---

## 3. `HostTaskBridge` API

### `AbstractHostTaskBridge` 构造函数选项

| 字段 | 类型 | 说明 |
|------|------|------|
| `client` | `AgentClient` | 必填，用于回报进度 / 发消息 |
| `requestAuth` | `(op: SensitiveOp) => Promise<void>` | 必填，转发到 `runtime.requestAuthorization(op)` |
| `sensitivePattern` | `RegExp` | 可选，命中即走授权流程，默认包含 删除/撤销/付费/revoke/delete/cancel/schema/drop… |
| `sensitiveOpType` | `string` | 可选，写入 `auth_requests.type`，默认 `"delete_data"`（参见 `types.ts` 的 `AUTH_OP_TYPES`） |

### `execute(task)` —— 由 `AgentRuntime` 调用（基类已实现，勿覆盖）

1. 若 `description` 命中 `sensitivePattern` → 调 `requestAuth()` 挂起，等人类批准；
   拒绝 / 超时抛 `AuthorizationRejected` / `AuthorizationExpired`，任务被标记 `failed`。
2. 回报 `in_progress @ 10%`。
3. 调 `runTask(task, report)` 拿到结果字符串 → 返回给 `AgentRuntime` 回写 `completed`。

### `runTask(task, report)` —— 你唯一要实现的钩子

```ts
protected abstract runTask(task: TaskEvent, report: ProgressReporter): Promise<string>;
```

- `task: TaskEvent` —— 任务详情（`id` / `description` / `context` / `priority` …）
- `report: (progress: number, message?: string) => Promise<void>` —— 在关键阶段回报进度
- 返回**结果字符串**，将被 Hub 持久化并回传给任务发起方

---

## 4. 接入宿主真实能力的接缝

`client-sdk/workbuddy-integration.ts` 与 `client-sdk/hermes-integration.ts` 内各有一个
标记好的接缝方法 `executeViaHost()`：

```ts
private async executeViaHost(task: TaskEvent): Promise<string> {
  // TODO(host): 替换为宿主真实执行器调用
  //   const plan  = await this.host.plan(task);
  //   const output = await this.host.runTools(plan);   // LLM / MCP 工具 / 脚本 / 外部 API
  await new Promise((r) => setTimeout(r, 300)); // 占位：模拟耗时，接入后删除
  return JSON.stringify({ note: "占位执行结果；请接入宿主真实能力。" }, null, 2);
}
```

把它替换为对**宿主自身运行时**的调用即可：

- **WorkBuddy**：调用其 LLM / 工具编排能力（参考 `parseIntent()` 做轻量预处理）。
- **Hermes**：调用其 Agent 运行时（加载上下文 → 调 LLM → 产出）。
- 自定义宿主：任何能接收 `TaskEvent` 并返回字符串的逻辑。

> ⚠️ 当前仓库内的 `executeViaHost` 是**安全占位**（结构化回显，保证可运行），
> 不是真实业务执行。生产接入时务必替换。

---

## 5. 授权（Feature B）示例

```ts
// 无需手写判定 —— AbstractHostTaskBridge 已内置：
//   命中 sensitivePattern 的任务会自动 requestAuthorization 并挂起，
//   人类在 Web 端的 AuthQueue 面板批准/拒绝后，任务才继续或中止。
//
// 自定义敏感类目示例：
new MyBridge({
  client,
  requestAuth: (op) => runtime.requestAuthorization(op),
  sensitivePattern: /发布|deploy|上线|publish/i,
  sensitiveOpType: "external_api",
});
```

可用 `op.type` 见 `client-sdk/types.ts` 的 `AUTH_OP_TYPES`：
`delete_data` / `cancel_task` / `revoke_token` / `cross_agent_delete` /
`send_external_email` / `external_api` / `paid_api` / `schema_change`。

---

## 6. 参考实现

| 文件 | 说明 |
|------|------|
| `client-sdk/adapters/host-task-bridge.ts` | `HostTaskBridge` 接口 + `AbstractHostTaskBridge` 基类 |
| `client-sdk/workbuddy-integration.ts` | WorkBuddy 接入示例（`WorkBuddyTaskBridge`） |
| `client-sdk/hermes-integration.ts` | Hermes 接入示例（`HermesTaskBridge`） |
| `client-sdk/runtime.ts` | `AgentRuntime` 与 `runAutonomousLoop` 工厂 |
| `docs/design/ach-autonomous-loop-hitl-auth.md` | 设计文档（自主闭环 + HITL 授权） |
