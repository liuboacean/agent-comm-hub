/**
 * API client for fetching Hub status and subscribing to audit stream.
 */

const BASE = window.location.origin;

export interface StatusData {
  agents: {
    total: number;
    online: number;
    by_state: Record<string, number>;
  };
  pipelines: {
    total: number;
    by_state: Record<string, number>;
  };
  throughput: {
    last_5min: number;
  };
  health: {
    fts5: string;
    active_sse: number;
  };
  top_limited: Array<{ agent_id: string; count: number }>;
  timestamp: number;
}

export interface AuditEntry {
  id: number;
  ts: string;
  action: string;
  operator: string;
  target: string;
  details: string;
}

export async function fetchStatus(): Promise<StatusData> {
  const res = await fetch(`${BASE}/api/status`);
  return res.json() as Promise<StatusData>;
}

export async function fetchAuditTail(n: number = 50): Promise<AuditEntry[]> {
  const res = await fetch(`${BASE}/api/audit/tail?n=${n}`);
  const json = await res.json() as { entries: AuditEntry[] };
  return json.entries ?? [];
}

// ═══════════════════════════════════════════════════
// Feature B: 人在环授权队列
// ═══════════════════════════════════════════════════

export type AuthRequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface AuthRequest {
  id: string;
  agent_id: string;
  task_id?: string | null;
  op_type: string;
  op_payload?: string | null;
  status: AuthRequestStatus;
  created_at: number;
  expires_at: number;
  resolved_by?: string | null;
  resolved_at?: number | null;
  decision_reason?: string | null;
}

/** 拉取授权请求列表（仪表盘轮询用）。默认不带 status 拿全部，传 pending 仅拿待办 */
export async function fetchAuthRequests(status?: AuthRequestStatus): Promise<AuthRequest[]> {
  const url = status
    ? `${BASE}/api/auth-requests?status=${encodeURIComponent(status)}`
    : `${BASE}/api/auth-requests`;
  const res = await fetch(url);
  const json = await res.json() as { requests: AuthRequest[] };
  return json.requests ?? [];
}

/** 批准/拒绝一个授权请求 */
export async function resolveAuthRequest(
  id: string,
  body: { decision: "approved" | "rejected"; reason?: string; grant_window_ms?: number }
): Promise<void> {
  const res = await fetch(`${BASE}/api/auth-requests/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((json.error as string) ?? `resolve failed: ${res.status}`);
  }
}
