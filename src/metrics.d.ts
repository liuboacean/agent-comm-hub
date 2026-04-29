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
export declare function incrementCounter(name: string, labels?: Record<string, string>, value?: number): void;
export declare function setGauge(name: string, value: number): void;
export declare function incrementGauge(name: string, value?: number): void;
export declare function decrementGauge(name: string, value?: number): void;
export declare function observeHistogram(name: string, valueMs: number, labels?: Record<string, string>): void;
export declare function getMetricsOutput(): string;
export declare function incrementMcpCall(toolName: string, status: "success" | "error" | "denied", role: string): void;
export declare function trackHttpRequest(method: string, path: string, statusCode: number, durationMs: number): void;
export declare function trackDbQuery(operation: string, durationMs: number): void;
