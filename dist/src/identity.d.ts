export declare const HEARTBEAT_CONFIG: {
    TRUST_SCORE_INCREMENT_INTERVAL: number;
    TRUST_SCORE_MAX: number;
};
export interface AgentInfo {
    agent_id: string;
    name: string;
    role: "admin" | "member" | "group_admin" | "superadmin";
    status: "online" | "offline";
    trust_score: number;
    last_heartbeat: number | null;
    created_at: number;
    capabilities?: string[];
}
/**
 * 注册新 Agent
 * @returns { agentId, apiToken } 或错误信息
 */
export declare function registerAgent(inviteCode: string, name: string, capabilities?: string[]): {
    success: boolean;
    agentId?: string;
    apiToken?: string;
    role?: string;
    error?: string;
};
/**
 * 处理 Agent 心跳
 * 连续在线心跳每 TRUST_SCORE_INCREMENT_INTERVAL 次自动增加 1 点 trust_score（上限 TRUST_SCORE_MAX）
 * @returns 更新后的状态
 */
export declare function heartbeat(agentId: string): {
    success: boolean;
    status: "online" | "offline";
    last_heartbeat: number;
    trust_score?: number;
    error?: string;
};
/**
 * 查询已注册的 Agent 列表
 */
export declare function queryAgents(filters?: {
    status?: "online" | "offline" | "all";
    role?: "admin" | "member" | "group_admin";
    capability?: string;
}): AgentInfo[];
/**
 * 查询单个 Agent 信息
 */
export declare function getAgent(agentId: string): AgentInfo | null;
/**
 * 统一「在线」判定：满足以下任一即在线
 *   1. 存在活跃的 SSE 实时连接（可达，可实时派单）
 *   2. 数据库心跳在阈值内（轮询型 Agent 仍存活）
 * 解决老问题：Agent 已建立 SSE 连接却因心跳陈旧被判定为离线、无法派单。
 */
export declare function isAgentOnline(agentId: string): boolean;
/**
 * 返回当前所有「在线」Agent 的 ID（合并 SSE 连接 + 心跳在线）。
 * 供 get_online_agents 工具、派单候选排序、/health、Prometheus 指标统一使用。
 */
export declare function getOnlineAgentIds(): string[];
/**
 * SSE 连接建立时调用：将 Agent 标记为在线（status + 刷新心跳时间戳），
 * 使 agents 表与「SSE 已连」这一事实保持一致。
 */
export declare function markAgentSseOnline(agentId: string): void;
/**
 * SSE 连接断开时调用：若心跳也已陈旧，则将 Agent 标记为离线；
 * 若仍有近期心跳（轮询型），保留在线状态。
 */
export declare function markAgentSseOffline(agentId: string): void;
/**
 * 启动心跳超时检测定时器
 * - 90s 无心跳 → 标记 offline
 * - 5min 无心跳 → 通知其他在线 Agent
 */
export declare function startHeartbeatMonitor(onAgentOffline?: (agentId: string) => void): void;
/**
 * 停止心跳超时检测
 */
export declare function stopHeartbeatMonitor(): void;
/**
 * 清除离线通知标记（Agent 重新上线时调用）
 */
export declare function clearOfflineNotification(agentId: string): void;
/**
 * 获取 Agent 信任分
 */
export declare function getAgentTrustScore(agentId: string): number;
/**
 * 更新 Agent 信任分（admin only）
 * @returns 更新后的信任分，或 null（Agent 不存在）
 */
export declare function updateAgentTrustScore(agentId: string, delta: number, operatorId?: string): {
    ok: true;
    new_score: number;
} | {
    ok: false;
    error: string;
};
/**
 * 设置 Agent 角色（admin only）
 * 支持 admin / member / group_admin 三种角色
 * group_admin 需要同时设置 managed_group_id
 */
export declare function setAgentRole(agentId: string, newRole: "admin" | "member" | "group_admin", operatorId: string, managedGroupId?: string): {
    ok: true;
    old_role: string;
    new_role: string;
    managed_group_id: string | null;
} | {
    ok: false;
    error: string;
};
/**
 * 获取 Agent 角色
 */
export declare function getAgentRole(agentId: string): string | null;
/**
 * 获取 Agent 的 managed_group_id
 */
export declare function getAgentManagedGroup(agentId: string): string | null;
/**
 * 获取心跳超时配置（用于测试）
 */
export declare function getHeartbeatConfig(): {
    onlineThreshold: number;
    notifyThreshold: number;
    checkInterval: number;
};
/**
 * 解析 Agent 标识符为完整 agent_id。
 * 支持：
 *   1. 完整 agent_id（已注册则返回）
 *   2. 已知别名（workbuddy / hermes / qclaw，大小写不敏感）
 *   3. agent_id 子串匹配（大小写不敏感）
 * 返回完整 agent_id 或 null（未找到）
 */
export declare function resolveAgentId(input: string): string | null;
