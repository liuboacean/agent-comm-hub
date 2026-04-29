/**
 * metrics.ts — Prometheus 兼容指标（Phase 5b）
 * 零依赖实现，内存存储
 *
 * 指标：
 *   - mcp_calls_total{tool_name, status, role} : Counter
 *   - active_sse_connections : Gauge
 *   - message_delivery_total{status} : Counter
 *   - http_requests_total{method, path, status} : Counter
 *   - http_request_duration_ms{method, path} : Histogram (简易)
 *   - db_query_duration_ms{operation} : Histogram (简易)
 */

// ─── Counter ─────────────────────────────────────────────

interface CounterMetric {
  _type: "counter";
  value: number;
  labels: Record<string, string>;
}

const counters: CounterMetric[] = [];

function getOrCreateCounter(name: string, labels: Record<string, string>): CounterMetric {
  for (const c of counters) {
    if (c.labels._name !== name) continue;
    let match = true;
    for (const k of Object.keys(labels)) {
      if (c.labels[k] !== labels[k]) { match = false; break; }
    }
    if (match) return c;
  }
  const c: CounterMetric = { _type: "counter", value: 0, labels: { _name: name, ...labels } };
  counters.push(c);
  return c;
}

export function incrementCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  const c = getOrCreateCounter(name, labels);
  c.value += value;
}

// ─── Gauge ───────────────────────────────────────────────

const gauges: Record<string, number> = {};

export function setGauge(name: string, value: number): void {
  gauges[name] = value;
}

export function incrementGauge(name: string, value = 1): void {
  gauges[name] = (gauges[name] ?? 0) + value;
}

export function decrementGauge(name: string, value = 1): void {
  gauges[name] = (gauges[name] ?? 0) - value;
}

// ─── Histogram（简易分桶）─────────────────────────────────

interface HistogramMetric {
  _type: "histogram";
  _sum: number;
  _count: number;
  _min: number;
  _max: number;
  buckets: Record<string, number>;
  labels: Record<string, string>;
}

const histograms: HistogramMetric[] = [];
const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function getOrCreateHistogram(name: string, labels: Record<string, string>): HistogramMetric {
  for (const h of histograms) {
    if (h.labels._name !== name) continue;
    let match = true;
    for (const k of Object.keys(labels)) {
      if (h.labels[k] !== labels[k]) { match = false; break; }
    }
    if (match) return h;
  }
  const h: HistogramMetric = {
    _type: "histogram",
    _sum: 0, _count: 0, _min: Infinity, _max: 0,
    buckets: {},
    labels: { _name: name, ...labels },
  };
  for (const b of HISTOGRAM_BUCKETS) h.buckets[String(b)] = 0;
  h.buckets["+Inf"] = 0;
  histograms.push(h);
  return h;
}

export function observeHistogram(name: string, valueMs: number, labels: Record<string, string> = {}): void {
  const h = getOrCreateHistogram(name, labels);
  h._sum += valueMs;
  h._count += 1;
  if (valueMs < h._min) h._min = valueMs;
  if (valueMs > h._max) h._max = valueMs;
  for (const b of HISTOGRAM_BUCKETS) {
    if (valueMs <= b) h.buckets[String(b)]++;
  }
  h.buckets["+Inf"]++;
}

// ─── Prometheus 文本输出 ─────────────────────────────────

function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
    .filter(([k]) => k !== "_name")
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return entries.length > 0 ? `{${entries.join(",")}}` : "";
}

export function getMetricsOutput(): string {
  const lines: string[] = [];

  // 声明所有已知指标类型（即使无数据也输出 # TYPE，便于 Prometheus 发现）
  const declaredTypes: Record<string, string> = {
    mcp_calls_total: "counter",
    active_sse_connections: "gauge",
    message_delivery_total: "counter",
    http_requests_total: "counter",
    http_request_duration_ms: "histogram",
    db_query_duration_ms: "histogram",
  };

  const seenTypes = new Set<string>();

  // Counters
  for (const c of counters) {
    const name = c.labels._name;
    seenTypes.add(name);
    const lbl = formatLabels(c.labels);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name}${lbl} ${c.value}`);
  }

  // Gauges
  for (const [name, value] of Object.entries(gauges)) {
    seenTypes.add(name);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  // Histograms
  for (const h of histograms) {
    const name = h.labels._name;
    seenTypes.add(name);
    const lbl = formatLabels(h.labels);
    lines.push(`# TYPE ${name} histogram`);
    // _sum, _count
    lines.push(`${name}_sum${lbl} ${Math.round(h._sum * 100) / 100}`);
    lines.push(`${name}_count${lbl} ${h._count}`);
    // _bucket
    for (const b of HISTOGRAM_BUCKETS) {
      lines.push(`${name}_bucket{le="${b}"${lbl ? ", " + lbl.slice(1, -1) : ""}} ${h.buckets[String(b)] ?? 0}`);
    }
    lines.push(`${name}_bucket{le="+Inf"${lbl ? ", " + lbl.slice(1, -1) : ""}} ${h.buckets["+Inf"] ?? 0}`);
  }

  // 声明尚未有数据的指标类型
  for (const [name, type] of Object.entries(declaredTypes)) {
    if (!seenTypes.has(name)) {
      lines.push(`# TYPE ${name} ${type}`);
      if (type === "counter" || type === "gauge") {
        lines.push(`${name} 0`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

// ─── 便捷函数（供 tools.ts / server.ts 埋点用） ───────────

export function incrementMcpCall(toolName: string, status: "success" | "error" | "denied", role: string): void {
  incrementCounter("mcp_calls_total", { tool_name: toolName, status, role });
}

export function trackHttpRequest(method: string, path: string, statusCode: number, durationMs: number): void {
  incrementCounter("http_requests_total", { method, path: simplifyPath(path), status: String(statusCode) });
  observeHistogram("http_request_duration_ms", durationMs, { method, path: simplifyPath(path) });
}

export function trackDbQuery(operation: string, durationMs: number): void {
  observeHistogram("db_query_duration_ms", durationMs, { operation });
}

function simplifyPath(path: string): string {
  // /api/tasks/abc123 → /api/tasks/:id
  return path.replace(/\/[a-f0-9-]{8,}/g, "/:id").replace(/\/\d+/g, "/:id");
}
