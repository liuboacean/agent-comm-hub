/**
 * orchestrator-tools.test.ts — 编排模块单元测试
 *
 * 测试纯函数：state-machine 状态转移 (0 依赖)，以及 ActivationOrchestrator 基础功能
 */
import { describe, it, expect } from "vitest";

import {
  isLegalAgentTransition,
  isLegalPipelineTransition,
} from "../../src/state-machine.js";

describe("state-machine — Agent transitions", () => {
  it("registered → active valid", () => {
    expect(isLegalAgentTransition("registered", "active")).toBe(true);
  });
  it("registered → suspended valid", () => {
    expect(isLegalAgentTransition("registered", "suspended")).toBe(true);
  });
  it("active → suspended valid", () => {
    expect(isLegalAgentTransition("active", "suspended")).toBe(true);
  });
  it("suspended → active valid", () => {
    expect(isLegalAgentTransition("suspended", "active")).toBe(true);
  });
  it("suspended → retired valid", () => {
    expect(isLegalAgentTransition("suspended", "retired")).toBe(true);
  });
  it("retired → active invalid", () => {
    expect(isLegalAgentTransition("retired", "active")).toBe(false);
  });
  it("active → registered invalid", () => {
    expect(isLegalAgentTransition("active", "registered")).toBe(false);
  });
  it("unknown → active invalid", () => {
    expect(isLegalAgentTransition("unknown" as any, "active")).toBe(false);
  });
});

describe("state-machine — Pipeline transitions", () => {
  it("draft → active valid", () => {
    expect(isLegalPipelineTransition("draft", "active")).toBe(true);
  });
  it("draft → cancelled valid", () => {
    expect(isLegalPipelineTransition("draft", "cancelled")).toBe(true);
  });
  it("active → paused valid", () => {
    expect(isLegalPipelineTransition("active", "paused")).toBe(true);
  });
  it("active → completed valid", () => {
    expect(isLegalPipelineTransition("active", "completed")).toBe(true);
  });
  it("active → cancelled valid", () => {
    expect(isLegalPipelineTransition("active", "cancelled")).toBe(true);
  });
  it("paused → active valid", () => {
    expect(isLegalPipelineTransition("paused", "active")).toBe(true);
  });
  it("completed → active invalid", () => {
    expect(isLegalPipelineTransition("completed", "active")).toBe(false);
  });
  it("cancelled → active invalid", () => {
    expect(isLegalPipelineTransition("cancelled", "active")).toBe(false);
  });
});

// ActivationOrchestrator 类由于需要通过 better-sqlite3 加载 db 模块，
// 在 vitest 环境中无法直接构造，此处仅测试纯状态机函数。
// 集成测试建议用内存 SQLite + 实际 orchestrator 模块独立测试。
