/**
 * state-machine.ts — Agent + Pipeline 状态机 + 合法转移表（P1-4）
 *
 * Agent 状态: registered → active | suspended
 *              active    → suspended
 *              suspended → active | retired
 *              retired   → (终态)
 *
 * Pipeline 状态: draft → active | cancelled
 *                active → paused | completed | cancelled
 *                paused → active | cancelled
 *                completed → (终态)
 *                cancelled → (终态)
 *
 * 与现有 orchestrator.ts 的 VALID_TRANSITIONS（8 task 状态）模式一致。
 */
export type AgentState = "registered" | "active" | "suspended" | "retired";
export declare const AGENT_VALID_TRANSITIONS: Record<AgentState, AgentState[]>;
export declare function isLegalAgentTransition(from: AgentState, to: AgentState): boolean;
export type PipelineState = "draft" | "active" | "paused" | "completed" | "cancelled";
export declare const PIPELINE_VALID_TRANSITIONS: Record<PipelineState, PipelineState[]>;
export declare function isLegalPipelineTransition(from: PipelineState, to: PipelineState): boolean;
