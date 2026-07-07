/**
 * metrics.test.ts — Metrics 模块单元测试
 *
 * 覆盖：incrementCounter / setGauge / incrementMcpCall / getTopLimited / getMetricsOutput
 */
import { describe, it, expect } from "vitest";

import {
  incrementCounter,
  setGauge,
  incrementGauge,
  decrementGauge,
  getMetricsOutput,
  incrementMcpCall,
  trackHttpRequest,
  trackDbQuery,
  getTopLimited,
} from "../../src/metrics.js";

describe("Metrics — counters", () => {
  it("should increment a counter", () => {
    incrementCounter("ctr_test_a");
    const output = getMetricsOutput();
    expect(output).toContain("ctr_test_a");
  });

  it("should increment by value", () => {
    incrementCounter("ctr_test_b", { key: "x" }, 5);
    const output = getMetricsOutput();
    expect(output).toContain("ctr_test_b");
  });
});

describe("Metrics — gauges", () => {
  it("should set a gauge", () => {
    setGauge("g_test", 42);
    expect(getMetricsOutput()).toContain("g_test 42");
  });

  it("should increment a gauge", () => {
    incrementGauge("g_inc", 3);
    expect(getMetricsOutput()).toContain("g_inc");
  });

  it("should decrement a gauge", () => {
    decrementGauge("g_dec", 1);
    expect(getMetricsOutput()).toContain("g_dec");
  });
});

describe("Metrics — convenience functions", () => {
  it("incrementMcpCall", () => {
    incrementMcpCall("tool_a", "success", "admin");
    expect(getMetricsOutput()).toContain("mcp_calls_total");
  });

  it("trackHttpRequest", () => {
    trackHttpRequest("GET", "/api/test", 200, 15);
    const out = getMetricsOutput();
    expect(out).toContain("http_requests_total");
  });

  it("trackDbQuery", () => {
    trackDbQuery("SELECT", 5);
    expect(getMetricsOutput()).toContain("db_query_duration_ms");
  });
});

describe("Metrics — getTopLimited", () => {
  it("should return array", () => {
    incrementCounter("rate_limit_total", { agent_id: "a" });
    const top = getTopLimited(5);
    expect(Array.isArray(top)).toBe(true);
  });
});
