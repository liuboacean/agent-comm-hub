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
