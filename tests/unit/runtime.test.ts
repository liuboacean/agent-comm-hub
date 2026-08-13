/**
 * runtime.test.ts — 单元测试 for client-sdk/runtime.ts (AgentRuntime)
 * 覆盖：inFlight 去重、崩溃恢复重跑 in_progress/assigned、loopGuard 防自杀循环
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { AgentRuntime, type TaskEvent } from "../../client-sdk/runtime.js";
import { AuthorizationRejected, AuthorizationExpired } from "../../client-sdk/agent-client.js";

/** 最小化的 AgentClient 桩（继承 EventEmitter，提供 runtime 需要的几个方法） */
class FakeClient extends EventEmitter {
  agentId = "rt-agent";
  updateTaskStatusCalls: Array<{ id: string; status: string; result?: string; progress?: number }> = [];
  updateTaskStatus = vi.fn(async (id: string, status: string, result?: string, progress?: number) => {
    this.updateTaskStatusCalls.push({ id, status, result, progress });
  });
  getTasks = vi.fn(async (status: string) => {
    if (status === "in_progress") return { tasks: this.inProgress };
    if (status === "assigned") return { tasks: this.assigned };
    return { tasks: [] };
  });
  requestAuthorization = vi.fn(async () => { /* 本测试不直接用 */ });
  inProgress: TaskEvent[] = [];
  assigned: TaskEvent[] = [];

  constructor() {
    super();
  }
}

function mkTask(id: string, description: string): TaskEvent {
  return {
    id,
    assigned_by: "orchestrator",
    assigned_to: "rt-agent",
    description,
    context: "",
    priority: "normal",
    status: "assigned",
    instruction: "",
  };
}

describe("AgentRuntime", () => {
  let client: FakeClient;
  let rt: AgentRuntime;

  afterEach(() => {
    rt?.stop();
  });

  it("去重：同一 task.id 因实时推+补发只执行一次", async () => {
    client = new FakeClient();
    const execute = vi.fn(async () => "done");
    rt = new AgentRuntime(client as any, execute, { requeueIncomplete: false });
    await rt.start();

    const task = mkTask("t1", "执行任务");
    client.emit("task_assigned", task);
    client.emit("task_assigned", task); // 重复（补发）

    await new Promise((r) => setTimeout(r, 20));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(client.updateTaskStatus).toHaveBeenCalledWith("t1", "completed", "done", 100);
  });

  it("正常流程：in_progress → execute → completed", async () => {
    client = new FakeClient();
    const execute = vi.fn(async () => "result-xyz");
    rt = new AgentRuntime(client as any, execute, { requeueIncomplete: false });
    await rt.start();

    client.emit("task_assigned", mkTask("t2", "任务2"));

    await new Promise((r) => setTimeout(r, 20));
    expect(client.updateTaskStatus).toHaveBeenCalledWith("t2", "in_progress", undefined, 5);
    expect(client.updateTaskStatus).toHaveBeenCalledWith("t2", "completed", "result-xyz", 100);
  });

  it("loopGuard：窗口内相同 description 重分配超阈值即跳过", async () => {
    client = new FakeClient();
    const execute = vi.fn(async () => "done");
    rt = new AgentRuntime(client as any, execute, {
      requeueIncomplete: false,
      loopGuard: { windowMs: 30000, maxIdentical: 2 },
    });
    await rt.start();

    client.emit("task_assigned", mkTask("a", "same-desc"));
    client.emit("task_assigned", mkTask("b", "same-desc"));
    client.emit("task_assigned", mkTask("c", "same-desc")); // 第 3 次命中护栏 → 跳过

    await new Promise((r) => setTimeout(r, 30));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("崩溃恢复：start() 重跑 in_progress + assigned 任务", async () => {
    client = new FakeClient();
    client.inProgress = [mkTask("p1", "恢复中1")];
    client.assigned = [mkTask("a1", "恢复中2")];
    const execute = vi.fn(async () => "ok");
    rt = new AgentRuntime(client as any, execute, { requeueIncomplete: true });
    await rt.start();

    await new Promise((r) => setTimeout(r, 30));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(client.updateTaskStatus).toHaveBeenCalledWith("p1", "completed", "ok", 100);
    expect(client.updateTaskStatus).toHaveBeenCalledWith("a1", "completed", "ok", 100);
  });

  it("execute 抛 AuthorizationRejected → 任务标记 failed 且携带原因", async () => {
    client = new FakeClient();
    const execute = vi.fn(async (task: TaskEvent) => {
      throw new AuthorizationRejected({ type: "delete_data", description: task.description }, "不安全");
    });
    const onError = vi.fn();
    rt = new AgentRuntime(client as any, execute, { requeueIncomplete: false, onError });
    await rt.start();

    client.emit("task_assigned", mkTask("t3", "敏感任务"));
    await new Promise((r) => setTimeout(r, 20));

    const failedCall = client.updateTaskStatusCalls.find((c) => c.status === "failed");
    expect(failedCall).toBeTruthy();
    expect(failedCall!.result).toContain("授权被拒");
    expect(failedCall!.result).toContain("不安全");
    expect(onError).toHaveBeenCalledWith("t3", expect.any(AuthorizationRejected));
  });

  it("execute 抛 AuthorizationExpired → 任务标记 failed", async () => {
    client = new FakeClient();
    const execute = vi.fn(async (task: TaskEvent) => {
      throw new AuthorizationExpired({ type: "delete_data", description: task.description });
    });
    rt = new AgentRuntime(client as any, execute, { requeueIncomplete: false });
    await rt.start();

    client.emit("task_assigned", mkTask("t4", "敏感任务"));
    await new Promise((r) => setTimeout(r, 20));

    const failedCall = client.updateTaskStatusCalls.find((c) => c.status === "failed");
    expect(failedCall).toBeTruthy();
    expect(failedCall!.result).toContain("授权过期");
  });

  it("runAutonomousLoop 工厂返回 AgentRuntime 实例", async () => {
    client = new FakeClient();
    const rt2 = (await import("../../client-sdk/runtime.js")).runAutonomousLoop(
      client as any,
      async () => "x"
    );
    expect(rt2).toBeInstanceOf(AgentRuntime);
    rt2.stop();
  });
});
