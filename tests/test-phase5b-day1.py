#!/usr/bin/env python3
"""
Phase 5b Day 1 测试 — 生产就绪（Production Readiness）
测试内容：
  Section 1: 健康检查增强（/health 返回 version + uptime + memory + db_size + tables + sse）
  Section 2: Prometheus Metrics 端点（/metrics 返回文本格式）
  Section 3: 安全头（X-Frame-Options / X-Content-Type-Options / HSTS / CSP）
  Section 4: CORS 策略（非白域名被拒）
  Section 5: traceId 追踪（请求头/响应头传递）
  Section 6: 全局错误处理（404 返回 JSON）
  Section 7: 结构化日志（logger.ts 编译 + 导出验证）
  Section 8: 源码无 console.log/error/warn 残留
  Section 9: 回归（tsc + MCP 工具数 40）
"""

import sqlite3
import subprocess
import sys
import os
import time
import json
import requests

HUB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(HUB_DIR, "comm_hub.db")
HUB_URL = "http://127.0.0.1:3100"

passed = 0
failed = 0
results = {}
current_section = []


def check(condition, description):
    global passed, failed
    if condition:
        passed += 1
        current_section.append(f"  ✅ {description}")
    else:
        failed += 1
        current_section.append(f"  ❌ {description}")


def run_section(name, func):
    global current_section, results
    current_section = []
    func()
    results[name] = list(current_section)
    section_passed = sum(1 for r in results[name] if "✅" in r)
    section_total = len(results[name])
    results[name].append(f"  📊 {section_passed}/{section_total}")
    print(f"\n{'='*60}")
    print(f"  {name}")
    print(f"{'='*60}")
    for r in results[name]:
        print(r)


def cleanup():
    """清理测试数据"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM agents WHERE agent_id LIKE 'test_5b%'")
    c.execute("DELETE FROM auth_tokens WHERE agent_id LIKE 'test_5b%'")
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════════════════════
# Section 1: 增强健康检查
# ═══════════════════════════════════════════════════════════════
def test_health_enhanced():
    """验证 /health 返回完整运行状态"""
    try:
        r = requests.get(f"{HUB_URL}/health", timeout=5)
        check(r.status_code == 200, f"GET /health → {r.status_code}")
        data = r.json()

        check(data.get("status") == "ok", f"status = ok")
        check(data.get("version") == "2.2.0", f"version = 2.2.0")

        check("uptime" in data, f"uptime 字段存在: {data.get('uptime', 'MISSING')}")
        check(isinstance(data.get("uptime"), (int, float)), f"uptime 是数字类型")

        check("timestamp" in data, f"timestamp 字段存在")
        check(isinstance(data.get("timestamp"), int), f"timestamp 是整数")

        check("memory" in data, f"memory 字段存在")
        mem = data.get("memory", {})
        check("rss" in mem, f"memory.rss 存在: {mem.get('rss', 'MISSING')} MB")
        check("heap_used" in mem, f"memory.heap_used 存在: {mem.get('heap_used', 'MISSING')} MB")
        check("heap_total" in mem, f"memory.heap_total 存在: {mem.get('heap_total', 'MISSING')} MB")
        check(mem.get("rss", 0) > 0, f"rss > 0")

        check("db" in data, f"db 字段存在")
        db_info = data.get("db", {})
        check("size" in db_info, f"db.size 存在: {db_info.get('size', 'MISSING')} bytes")
        check("tables" in db_info, f"db.tables 存在")
        check(isinstance(db_info.get("tables"), dict), f"db.tables 是字典")

        check("sse" in data, f"sse 字段存在")
        sse = data.get("sse", {})
        check("active_connections" in sse, f"sse.active_connections 存在: {sse.get('active_connections', 'MISSING')}")
    except Exception as e:
        check(False, f"健康检查请求失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 2: Prometheus Metrics 端点
# ═══════════════════════════════════════════════════════════════
def test_metrics_endpoint():
    """验证 /metrics 返回 Prometheus 文本格式"""
    try:
        r = requests.get(f"{HUB_URL}/metrics", timeout=5)
        check(r.status_code == 200, f"GET /metrics → {r.status_code}")

        ct = r.headers.get("Content-Type", "")
        check("text/plain" in ct, f"Content-Type 包含 text/plain: {ct}")

        body = r.text
        check(len(body) > 0, f"metrics body 非空 ({len(body)} chars)")

        # 验证有 # TYPE 声明
        check("# TYPE" in body, f"包含 # TYPE 声明")

        # 验证计数器格式
        check("http_requests_total" in body, f"包含 http_requests_total 指标")

        # 产生一些请求后再检查
        requests.get(f"{HUB_URL}/health", timeout=5)
        requests.get(f"{HUB_URL}/health", timeout=5)
        time.sleep(0.5)

        r2 = requests.get(f"{HUB_URL}/metrics", timeout=5)
        body2 = r2.text
        check("http_requests_total" in body2, f"产生请求后仍有 http_requests_total")

        # 验证 histogram 指标格式
        check("http_request_duration_ms" in body2, f"包含 http_request_duration_ms histogram")
        check("_bucket" in body2, f"包含 histogram _bucket")

    except Exception as e:
        check(False, f"Metrics 端点请求失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 3: 安全头
# ═══════════════════════════════════════════════════════════════
def test_security_headers():
    """验证安全响应头"""
    try:
        r = requests.get(f"{HUB_URL}/health", timeout=5)

        xfo = r.headers.get("X-Frame-Options", "")
        check(xfo == "DENY", f"X-Frame-Options = DENY (got: {xfo})")

        xcto = r.headers.get("X-Content-Type-Options", "")
        check(xcto == "nosniff", f"X-Content-Type-Options = nosniff (got: {xcto})")

        hsts = r.headers.get("Strict-Transport-Security", "")
        check("max-age=31536000" in hsts, f"HSTS max-age=31536000 (got: {hsts})")

        csp = r.headers.get("Content-Security-Policy", "")
        check("default-src" in csp, f"CSP 包含 default-src (got: {csp})")
    except Exception as e:
        check(False, f"安全头检查失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 4: CORS 策略
# ═══════════════════════════════════════════════════════════════
def test_cors_policy():
    """验证 CORS：非白域名被拒"""
    try:
        # 非白域名 Origin
        headers = {"Origin": "https://evil.example.com"}
        r = requests.get(f"{HUB_URL}/health", headers=headers, timeout=5)
        acao = r.headers.get("Access-Control-Allow-Origin", "")
        check(acao != "https://evil.example.com", f"非白域名被拒: ACAO = '{acao}'")

        # OPTIONS preflight 检查
        r2 = requests.options(f"{HUB_URL}/health", headers=headers, timeout=5)
        acao2 = r2.headers.get("Access-Control-Allow-Origin", "")
        check(acao2 != "https://evil.example.com", f"OPTIONS 非白域名被拒: ACAO = '{acao2}'")
    except Exception as e:
        check(False, f"CORS 检查失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 5: traceId 追踪
# ═══════════════════════════════════════════════════════════════
def test_trace_id():
    """验证 traceId 在请求中传递"""
    try:
        # 带 traceId 请求
        tid = "test-trace-abc123"
        r = requests.get(f"{HUB_URL}/health", headers={"X-Trace-Id": tid}, timeout=5)
        resp_tid = r.headers.get("X-Trace-Id", "")
        check(resp_tid == tid, f"X-Trace-Id 响应头匹配: {resp_tid}")

        # 不带 traceId 时自动生成
        r2 = requests.get(f"{HUB_URL}/health", timeout=5)
        resp_tid2 = r2.headers.get("X-Trace-Id", "")
        check(len(resp_tid2) > 0, f"自动生成 traceId: {resp_tid2}")
        check(len(resp_tid2) == 8, f"自动 traceId 长度 8: {len(resp_tid2)}")

        # 两次请求 traceId 不同
        r3 = requests.get(f"{HUB_URL}/health", timeout=5)
        resp_tid3 = r3.headers.get("X-Trace-Id", "")
        check(resp_tid2 != resp_tid3, f"两次自动 traceId 不同: {resp_tid2} != {resp_tid3}")
    except Exception as e:
        check(False, f"traceId 检查失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 6: 全局错误处理
# ═══════════════════════════════════════════════════════════════
def test_error_handler():
    """验证 404 返回 JSON + traceId"""
    try:
        r = requests.get(f"{HUB_URL}/nonexistent-path-404", timeout=5)
        check(r.status_code == 404, f"404 路径 → {r.status_code}")

        ct = r.headers.get("Content-Type", "")
        check("application/json" in ct, f"404 返回 JSON: {ct}")

        try:
            data = r.json()
            check("error" in data, f"404 body 包含 error 字段")
            check("traceId" in data, f"404 body 包含 traceId 字段: {data.get('traceId')}")
        except:
            check(False, f"404 body 不是合法 JSON")
    except Exception as e:
        check(False, f"错误处理检查失败: {e}")


# ═══════════════════════════════════════════════════════════════
# Section 7: 结构化日志
# ═══════════════════════════════════════════════════════════════
def test_logger_module():
    """验证 logger.ts 编译产物存在且导出正确"""
    logger_js = os.path.join(HUB_DIR, "src", "logger.js")
    check(os.path.exists(logger_js), f"src/logger.js 存在")

    if os.path.exists(logger_js):
        with open(logger_js) as f:
            content = f.read()
        check("JSON.stringify" in content, f"logger 使用 JSON.stringify")
        check("process.stdout" in content or "process.stderr" in content, f"logger 输出到 stdout/stderr")
        check("shouldLog" in content, f"logger 有 LOG_LEVEL 过滤")

    metrics_js = os.path.join(HUB_DIR, "src", "metrics.js")
    check(os.path.exists(metrics_js), f"src/metrics.js 存在")

    if os.path.exists(metrics_js):
        with open(metrics_js) as f:
            content = f.read()
        check("getMetricsOutput" in content, f"metrics 导出 getMetricsOutput")
        check("incrementCounter" in content, f"metrics 导出 incrementCounter")
        check("observeHistogram" in content, f"metrics 导出 observeHistogram")
        check("# TYPE" in content, f"metrics 生成 Prometheus # TYPE 行")


# ═══════════════════════════════════════════════════════════════
# Section 8: 源码无 console 残留
# ═══════════════════════════════════════════════════════════════
def test_no_console_residual():
    """验证 .ts 源码中不再有 console.log/error/warn（logger.ts 除外）"""
    ts_files = [f for f in os.listdir(os.path.join(HUB_DIR, "src")) if f.endswith(".ts")]
    violations = []

    for fname in ts_files:
        if fname == "logger.ts":
            continue
        fpath = os.path.join(HUB_DIR, "src", fname)
        with open(fpath) as f:
            for i, line in enumerate(f, 1):
                stripped = line.strip()
                # 跳过注释和字符串中的 console
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue
                if "console.log(" in stripped or "console.error(" in stripped or "console.warn(" in stripped:
                    violations.append(f"{fname}:{i}")

    check(len(violations) == 0, f".ts 源码无 console 残留 ({len(violations)} violations)")
    if violations:
        for v in violations[:5]:
            current_section.append(f"    → {v}")
        if len(violations) > 5:
            current_section.append(f"    → ... and {len(violations) - 5} more")


# ═══════════════════════════════════════════════════════════════
# Section 9: 回归测试
# ═══════════════════════════════════════════════════════════════
def test_regression():
    """tsc --noEmit + MCP 工具数 40"""
    # tsc --noEmit
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, cwd=HUB_DIR, timeout=60,
    )
    check(result.returncode == 0, f"tsc --noEmit 零错误")
    if result.returncode != 0:
        current_section.append(f"    stderr: {result.stderr[:200]}")

    # MCP 工具数 40
    tools_py = os.path.join(HUB_DIR, "tests", "helpers", "count_tools.py")
    if os.path.exists(tools_py):
        result2 = subprocess.run(
            ["python3", tools_py],
            capture_output=True, text=True, cwd=HUB_DIR, timeout=30,
        )
        output = result2.stdout.strip()
        check("40" in output, f"MCP 工具数 40 (got: {output})")
    else:
        # 备用检查：grep server.tool(
        tools_ts = os.path.join(HUB_DIR, "src", "tools.ts")
        with open(tools_ts) as f:
            count = f.read().count("server.tool(")
        check(count == 40, f"MCP 工具数 40 (grep: {count})")

    # DB 无新表
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [row[0] for row in c.fetchall()]
    conn.close()

    # 验证无 Phase 5b 新增表（零新表承诺）
    check("metrics" not in tables, f"无 metrics 表（内存存储）")
    check("logs" not in tables, f"无 logs 表（stdout 输出）")


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    cleanup()

    run_section("Section 1: 增强健康检查", test_health_enhanced)
    run_section("Section 2: Prometheus Metrics 端点", test_metrics_endpoint)
    run_section("Section 3: 安全头", test_security_headers)
    run_section("Section 4: CORS 策略", test_cors_policy)
    run_section("Section 5: traceId 追踪", test_trace_id)
    run_section("Section 6: 全局错误处理", test_error_handler)
    run_section("Section 7: 结构化日志模块", test_logger_module)
    run_section("Section 8: 源码无 console 残留", test_no_console_residual)
    run_section("Section 9: 回归", test_regression)

    # 摘要
    print(f"\n{'='*60}")
    print(f"  Phase 5b Day 1 测试摘要")
    print(f"{'='*60}")
    print(f"  ✅ 通过: {passed}")
    print(f"  ❌ 失败: {failed}")
    print(f"  📊 总计: {passed + failed}")
    if failed == 0:
        print(f"  🎉 全部通过！")
    else:
        print(f"  ⚠️  有失败项需要修复")
    print(f"{'='*60}")
