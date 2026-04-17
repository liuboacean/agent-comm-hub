/**
 * sse.ts — SSE 连接管理
 * 维护 AgentID → Response 映射，实现零轮询实时推送
 */
import type { Response } from "express";

// 在线 Agent 连接池
const clients = new Map<string, Response>();

/**
 * 注册 Agent 的 SSE 连接
 */
export function registerClient(agentId: string, res: Response): void {
  // 如果已有旧连接，先关掉（Agent 重启场景）
  const existing = clients.get(agentId);
  if (existing) {
    try { existing.end(); } catch (_) {}
  }
  clients.set(agentId, res);
  console.log(`[SSE] ✅ ${agentId} online. Total: ${clients.size}`);
}

/**
 * 移除 Agent 连接（断线时调用）
 */
export function removeClient(agentId: string): void {
  clients.delete(agentId);
  console.log(`[SSE] ❌ ${agentId} offline. Total: ${clients.size}`);
}

/**
 * 向指定 Agent 推送事件
 * @returns true = 在线已推送；false = 离线，消息已持久化等待补发
 */
export function pushToAgent(agentId: string, event: object): boolean {
  const res = clients.get(agentId);
  if (!res) return false;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch (err) {
    // 连接异常，移除
    removeClient(agentId);
    return false;
  }
}

/**
 * 广播给多个 Agent
 */
export function broadcast(agentIds: string[], event: object): Record<string, boolean> {
  const results: Record<string, boolean> = {};
  for (const id of agentIds) {
    results[id] = pushToAgent(id, event);
  }
  return results;
}

/**
 * 查询哪些 Agent 在线
 */
export function onlineAgents(): string[] {
  return [...clients.keys()];
}
