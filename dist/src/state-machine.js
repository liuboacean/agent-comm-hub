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
export const AGENT_VALID_TRANSITIONS = {
    registered: ["active", "suspended"],
    active: ["suspended"],
    suspended: ["active", "retired"],
    retired: [],
};
export function isLegalAgentTransition(from, to) {
    const allowed = AGENT_VALID_TRANSITIONS[from];
    if (!allowed)
        return false;
    return allowed.includes(to);
}
export const PIPELINE_VALID_TRANSITIONS = {
    draft: ["active", "cancelled"],
    active: ["paused", "completed", "cancelled"],
    paused: ["active", "cancelled"],
    completed: [],
    cancelled: [],
};
export function isLegalPipelineTransition(from, to) {
    const allowed = PIPELINE_VALID_TRANSITIONS[from];
    if (!allowed)
        return false;
    return allowed.includes(to);
}
//# sourceMappingURL=state-machine.js.map