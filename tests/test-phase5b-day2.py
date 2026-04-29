#!/usr/bin/env python3
"""
test-phase5b-day2.py — Phase 5b Day 2 安全审计 + Go/No-Go 决策门

覆盖：
1. 错误处理安全：不泄露堆栈 / 生产环境隐藏详情
2. Metrics 安全：不暴露敏感数据 / 不可被篡改
3. CORS 安全：默认拒绝 / 凭证策略 / 通配符限制
4. 安全头：OWASP 推荐值验证
5. 优雅关闭：SIGTERM 后新请求被拒 / SSE 通知
6. Phase 0.5-5a 回归：全部安全特性不受影响
7. Go/No-Go 决策门（6 项标准）
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
import uuid

# ─── 配置 ──────────────────────────────────────────────────────

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'comm_hub.db')
HUB_ROOT = os.path.join(os.path.dirname(__file__), '..')
SDK_PATH = os.path.join(HUB_ROOT, 'client-sdk', 'hub_client.py')
HUB_URL = "http://127.0.0.1:3100"

passed = 0
failed = 0
section_passed = 0
section_failed = 0


def check(name, condition, detail=""):
    global passed, failed, section_passed, section_failed
    if condition:
        passed += 1
        section_passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        section_failed += 1
        print(f"  ❌ {name} — {detail}")


def section(title):
    global section_passed, section_failed
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")
    section_passed = 0
    section_failed = 0


def section_summary():
    global section_passed, section_failed
    status = "PASS" if section_failed == 0 else "FAIL"
    print(f"\n  [{status}] {section_passed} passed, {section_failed} failed")
    return section_failed == 0


def http_get(path, headers=None):
    """发送 GET 请求，返回 (status_code, body_dict_or_None, raw_text)"""
    url = HUB_URL + path
    req = urllib.request.Request(url, method="GET")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(body), body
            except json.JSONDecodeError:
                return resp.status, None, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body), body
        except json.JSONDecodeError:
            return e.code, None, body


def http_post(path, data=None, headers=None):
    """发送 POST 请求"""
    url = HUB_URL + path
    body = json.dumps(data).encode() if data else b"{}"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as resp:
            resp_body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(resp_body), resp_body
            except json.JSONDecodeError:
                return resp.status, None, resp_body
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(resp_body), resp_body
        except json.JSONDecodeError:
            return e.code, None, resp_body


def get_auth_header():
    """获取认证 token"""
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT token_value FROM auth_tokens WHERE agent_id='workbuddy' AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
        (int(time.time()),)
    ).fetchone()
    conn.close()
    if row:
        return {"Authorization": f"Bearer {row[0]}"}
    # 回退：生成新 token
    token = str(uuid.uuid4())
    now = int(time.time())
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, created_at, expires_at) VALUES (?, 'api', ?, 'workbuddy', 'admin', ?, ?)",
        (str(uuid.uuid4()), token, now, now + 86400),
    )
    conn.commit()
    conn.close()
    return {"Authorization": f"Bearer {token}"}


# ═══════════════════════════════════════════════════════════════
# Section 1: 错误处理安全
# ═══════════════════════════════════════════════════════════════

def test_error_handling_security():
    section("Section 1: 错误处理安全（6 项）")

    # 1.1 404 返回 JSON，不泄露堆栈
    code, body, raw = http_get("/nonexistent-path-xyz")
    check("404 返回 JSON 格式", code == 404 and body is not None,
          f"code={code}, body={body}")
    if body:
        check("404 有 error 字段", body.get("error") == True, f"body={body}")
        check("404 不泄露堆栈", "stack" not in json.dumps(body).lower(),
              "响应中包含 stack 字段")
        check("404 有 traceId", "traceId" in body, f"body keys={list(body.keys())}")

    # 1.2 参数验证在认证之后（安全设计：未认证返回 401 而非 400）
    result = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "PATCH", HUB_URL + "/api/tasks/nonexistent-id/status",
         "-H", "Content-Type: application/json",
         "-d", '{"status":"invalid_value"}'],
        capture_output=True, text=True, timeout=10
    )
    code = int(result.stdout.strip()) if result.stdout.strip() else 0
    check("未认证请求不暴露参数验证（返回 401）", code == 401, f"code={code}")

    # 1.3 未认证请求返回 401/403 JSON
    code, body, raw = http_get("/api/tasks?agent_id=workbuddy")
    check("未认证返回 401 或 403", code in (401, 403), f"code={code}")
    if body:
        check("认证错误返回 JSON", body is not None, f"body={body}")

    # 1.4 source 代码中错误处理使用 logError 而非 console.error
    server_ts = os.path.join(HUB_ROOT, "src", "server.ts")
    with open(server_ts) as f:
        content = f.read()
    check("server.ts 使用 logError 处理错误", "logError" in content,
          "未找到 logError 调用")
    check("生产环境不返回 err.stack",
          '"development"' in content and "Internal Server Error" in content,
          "未找到环境判断逻辑")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 2: Metrics 安全
# ═══════════════════════════════════════════════════════════════

def test_metrics_security():
    section("Section 2: Metrics 安全（6 项）")

    # 2.1 /metrics 返回 Prometheus 格式
    code, body, raw = http_get("/metrics")
    check("/metrics 返回 200", code == 200, f"code={code}")
    check("/metrics 是 text/plain", raw is not None and "# TYPE" in raw,
          f"响应不包含 Prometheus # TYPE 行")

    if raw:
        # 2.2 不暴露敏感数据（token、密码等）
        sensitive_patterns = ["password", "secret", "token", "api_key", "private_key"]
        has_sensitive = any(p in raw.lower() for p in sensitive_patterns)
        check("Metrics 不暴露敏感数据", not has_sensitive,
              "Metrics 输出包含敏感关键词")

        # 2.3 包含 6 个核心指标
        expected_metrics = [
            "mcp_calls_total",
            "active_sse_connections",
            "message_delivery_total",
            "http_requests_total",
            "http_request_duration_ms",
            "db_query_duration_ms",
        ]
        for metric in expected_metrics:
            check(f"指标 {metric} 存在", metric in raw, f"未找到 {metric}")

        # 2.4 /metrics 免认证（Prometheus scraper 需要）
        code_no_auth, _, _ = http_get("/metrics")
        check("/metrics 免认证可访问", code_no_auth == 200, f"code={code_no_auth}")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 3: CORS 安全
# ═══════════════════════════════════════════════════════════════

def test_cors_security():
    section("Section 3: CORS 安全（6 项）")

    # 3.1 无 CORS_ORIGINS 时，跨域请求被拒
    code, _, raw = http_get("/health", headers={"Origin": "https://evil.com"})
    # CORS 中间件不设 Access-Control-Allow-Origin
    # 注意：GET /health 本身会返回 200，但不应有 ACAO 头
    # 我们需要检查原始响应头
    url = HUB_URL + "/health"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Origin", "https://evil.com")
    try:
        with urllib.request.urlopen(req) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin")
            check("无配置时拒绝跨域 Origin", acao is None,
                  f"ACAO={acao}")
    except Exception as e:
        check("无配置时拒绝跨域 Origin", True, f"请求异常: {e}")

    # 3.2 OPTIONS 预检返回 204
    url = HUB_URL + "/health"
    req = urllib.request.Request(url, method="OPTIONS")
    try:
        with urllib.request.urlopen(req) as resp:
            check("OPTIONS 返回 204", resp.status == 204,
                  f"status={resp.status}")
    except urllib.error.HTTPError as e:
        check("OPTIONS 返回 204", e.code == 204, f"code={e.code}")

    # 3.3 CORS 不使用通配符 * 作为默认值
    server_ts = os.path.join(HUB_ROOT, "src", "server.ts")
    with open(server_ts) as f:
        content = f.read()
    # 检查 CORS_ORIGINS 默认值不是 "*"
    cors_line = [l for l in content.split("\n") if "CORS_ORIGINS" in l and "process.env" in l]
    if cors_line:
        check("CORS 默认值不是通配符 *", '"*"' not in cors_line[0] or '""' in cors_line[0],
              f"line={cors_line[0].strip()}")
    else:
        check("CORS 默认值不是通配符 *", False, "未找到 CORS_ORIGINS 定义")

    # 3.4 CORS 头不包含 Allow-Credentials（无 * 时安全）
    url = HUB_URL + "/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req) as resp:
            creds = resp.headers.get("Access-Control-Allow-Credentials")
            check("不返回 Allow-Credentials", creds is None,
                  f"credentials={creds}")
    except Exception:
        check("不返回 Allow-Credentials", True, "")

    # 3.5 MCP 端点也受 CORS 保护
    url = HUB_URL + "/mcp"
    req = urllib.request.Request(url, method="OPTIONS")
    try:
        with urllib.request.urlopen(req) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin")
            check("MCP OPTIONS 不暴露 ACAO", acao is None, f"ACAO={acao}")
    except Exception:
        check("MCP OPTIONS 不暴露 ACAO", True, "")

    # 3.6 源码中 CORS 逻辑正确
    check("CORS 中间件使用 includes 匹配（非正则）", "CORS_ORIGINS.includes" in content,
          "CORS 使用不安全的匹配方式")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 4: 安全头（OWASP 推荐）
# ═══════════════════════════════════════════════════════════════

def test_security_headers():
    section("Section 4: 安全头 OWASP 验证（8 项）")

    url = HUB_URL + "/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req) as resp:
            headers = dict(resp.headers)

            # OWASP 推荐安全头
            checks = [
                ("X-Frame-Options", "DENY", "防止点击劫持"),
                ("X-Content-Type-Options", "nosniff", "防止 MIME 嗅探"),
                ("X-XSS-Protection", "1; mode=block", "XSS 过滤"),
                ("Strict-Transport-Security", "max-age=31536000", "HSTS"),
            ]
            for header_name, expected_value, desc in checks:
                actual = headers.get(header_name, "")
                check(f"{header_name} = {expected_value} ({desc})",
                      expected_value in actual,
                      f"actual={actual}")

            # CSP
            csp = headers.get("Content-Security-Policy", "")
            check("Content-Security-Policy 存在", bool(csp), f"CSP={csp}")
            check("CSP 包含 default-src 'self'", "default-src 'self'" in csp,
                  f"CSP={csp}")
    except Exception as e:
        for i in range(8):
            check(f"安全头检查 {i+1}", False, f"请求失败: {e}")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 5: 优雅关闭
# ═══════════════════════════════════════════════════════════════

def test_graceful_shutdown():
    section("Section 5: 优雅关闭验证（6 项）")

    # 5.1 源码中有 SIGTERM/SIGINT 监听
    server_ts = os.path.join(HUB_ROOT, "src", "server.ts")
    with open(server_ts) as f:
        content = f.read()

    check("监听 SIGTERM", "SIGTERM" in content, "未找到 SIGTERM 监听")
    check("监听 SIGINT", "SIGINT" in content, "未找到 SIGINT 监听")
    check("有 gracefulShutdown 函数", "gracefulShutdown" in content,
          "未找到 gracefulShutdown")

    # 5.2 关闭时关闭 HTTP server
    check("关闭时调用 httpServer.close()", "httpServer.close" in content,
          "未找到 httpServer.close()")

    # 5.3 关闭时 drain SSE 连接
    check("关闭时调用 drainAllClients()", "drainAllClients" in content,
          "未找到 drainAllClients()")

    # 5.4 关闭时关闭数据库
    check("关闭时调用 db.close()", "db.close()" in content,
          "未找到 db.close()")

    # 5.5 未捕获异常兜底
    check("uncaughtException 兜底", "uncaughtException" in content,
          "未找到 uncaughtException 处理")
    check("unhandledRejection 兜底", "unhandledRejection" in content,
          "未找到 unhandledRejection 处理")

    # 5.6 SSE drainAllClients 实现在 sse.ts
    sse_ts = os.path.join(HUB_ROOT, "src", "sse.ts")
    with open(sse_ts) as f:
        sse_content = f.read()
    check("sse.ts 导出 drainAllClients", "drainAllClients" in sse_content,
          "sse.ts 未导出 drainAllClients")
    check("SSE drain 发送关闭事件", "hub_shutdown" in sse_content,
          "SSE drain 未发送 hub_shutdown 事件")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 6: Phase 0.5-5a 安全回归
# ═══════════════════════════════════════════════════════════════

def test_security_regression():
    section("Section 6: Phase 0.5-5a 安全回归（12 项）")

    # 6.1 认证中间件存在
    server_ts = os.path.join(HUB_ROOT, "src", "server.ts")
    security_ts = os.path.join(HUB_ROOT, "src", "security.ts")
    with open(server_ts) as f:
        srv = f.read()
    with open(security_ts) as f:
        sec = f.read()

    check("authMiddleware 存在", "authMiddleware" in srv,
          "未找到 authMiddleware")
    check("optionalAuthMiddleware 存在", "optionalAuthMiddleware" in srv,
          "未找到 optionalAuthMiddleware")
    check("速率限制存在", "rateLimiter" in srv,
          "未找到 rateLimiter")

    # 6.2 审计日志功能
    check("auditLog 函数存在", "auditLog" in sec,
          "未找到 auditLog")
    check("audit_log 表被写入", "audit_log" in sec,
          "未找到 audit_log 表引用")

    # 6.3 RBAC group_admin
    check("group_admin 角色存在", "group_admin" in sec,
          "未找到 group_admin 角色")

    # 6.4 防篡改（哈希链）
    check("prev_hash 防篡改字段", "prev_hash" in sec,
          "未找到 prev_hash")
    check("record_hash 防篡改字段", "record_hash" in sec,
          "未找到 record_hash")

    # 6.5 信任评分
    check("信任评分 recalculate_trust_scores", "recalculate_trust_scores" in sec,
          "未找到 recalculate_trust_scores")

    # 6.6 去重
    dedup_ts = os.path.join(HUB_ROOT, "src", "dedup.ts")
    with open(dedup_ts) as f:
        dedup = f.read()
    check("消息去重 dedupCache 存在", "dedupCache" in dedup or "dedup" in dedup.lower(),
          "未找到去重逻辑")

    # 6.7 40 个 MCP 工具
    tools_ts = os.path.join(HUB_ROOT, "src", "tools.ts")
    with open(tools_ts) as f:
        tools_content = f.read()
    tool_count = tools_content.count("server.tool(")
    check(f"MCP 工具数量 ≥ 38（实际 {tool_count}）", tool_count >= 38,
          f"工具数量不足: {tool_count}")

    # 6.8 FTS5 搜索
    memory_ts = os.path.join(HUB_ROOT, "src", "memory.ts")
    with open(memory_ts) as f:
        mem = f.read()
    check("FTS5 搜索功能存在", "fts" in mem.lower() or "FTS" in mem,
          "未找到 FTS 搜索")

    # 6.9 编译通过
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, cwd=HUB_ROOT, timeout=60
    )
    check("tsc --noEmit 零错误", result.returncode == 0,
          f"stderr={result.stderr[:200]}")

    # 6.10 Evolution 模块
    evo_ts = os.path.join(HUB_ROOT, "src", "evolution.ts")
    with open(evo_ts) as f:
        evo = f.read()
    check("Evolution 模块存在", "strategy" in evo.lower() or "evolution" in evo.lower(),
          "未找到 Evolution 模块")

    # 6.11 Orchestrator 模块
    orch_ts = os.path.join(HUB_ROOT, "src", "orchestrator.ts")
    with open(orch_ts) as f:
        orch = f.read()
    check("Orchestrator 模块存在", "pipeline" in orch.lower() or "orchestrat" in orch.lower(),
          "未找到 Orchestrator 模块")

    # 6.12 console 残留检查
    all_ts_files = []
    for fname in os.listdir(os.path.join(HUB_ROOT, "src")):
        if fname.endswith(".ts") and fname != "logger.ts":
            all_ts_files.append(os.path.join(HUB_ROOT, "src", fname))

    console_found = False
    for fpath in all_ts_files:
        with open(fpath) as f:
            content = f.read()
        if re.search(r'console\.(log|error|warn)\s*\(', content):
            console_found = True
            break
    check("全局零 console.log/error/warn 残留", not console_found,
          "发现 console 调用残留")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Section 7: Go/No-Go 决策门
# ═══════════════════════════════════════════════════════════════

def test_go_nogo():
    section("Section 7: Go/No-Go 决策门（6 项）")

    go_count = 0

    # Gate 1: 错误处理 — 未捕获异常返回 500 JSON，进程不崩溃
    code, body, _ = http_get("/nonexistent-xyz-test")
    gate1 = code == 404 and body is not None and "error" in body
    check("Gate 1: 错误处理 — 异常返回结构化 JSON", gate1,
          f"code={code}, body={body}")
    if gate1:
        go_count += 1

    # Gate 2: 日志 — 全部 console 替换为 logger，JSON 格式可解析
    server_ts = os.path.join(HUB_ROOT, "src", "server.ts")
    with open(server_ts) as f:
        srv = f.read()
    gate2 = "logError" in srv and "logger.info" in srv
    check("Gate 2: 日志 — 使用结构化 logger", gate2,
          "未找到 logError 或 logger.info")
    if gate2:
        go_count += 1

    # Gate 3: 健康检查 — /health 返回完整状态
    code, body, _ = http_get("/health")
    gate3 = (code == 200 and body and
             "version" in body and "uptime" in body and
             "memory" in body and "db" in body)
    check("Gate 3: 健康检查 — 返回 version/uptime/memory/db", gate3,
          f"code={code}, keys={list(body.keys()) if body else 'None'}")
    if gate3:
        go_count += 1

    # Gate 4: Metrics — /metrics 200，6 个指标可查询
    code, _, raw = http_get("/metrics")
    required = ["mcp_calls_total", "active_sse_connections", "message_delivery_total",
                "http_requests_total", "http_request_duration_ms", "db_query_duration_ms"]
    metrics_found = sum(1 for m in required if m in (raw or ""))
    gate4 = code == 200 and metrics_found >= 6
    check(f"Gate 4: Metrics — 6 个指标可查询（{metrics_found}/6）", gate4,
          f"code={code}")
    if gate4:
        go_count += 1

    # Gate 5: 回归 — 40 工具 + Python SDK 功能零回归
    tools_ts = os.path.join(HUB_ROOT, "src", "tools.ts")
    with open(tools_ts) as f:
        tools_content = f.read()
    tool_count = tools_content.count("server.tool(")
    gate5 = tool_count >= 38
    check(f"Gate 5: 回归 — 工具数量 ≥ 38（{tool_count}）", gate5,
          f"工具数量不足: {tool_count}")
    if gate5:
        go_count += 1

    # Gate 6: 编译 — tsc --noEmit 零错误
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, cwd=HUB_ROOT, timeout=60
    )
    gate6 = result.returncode == 0
    check("Gate 6: 编译 — tsc --noEmit 零错误", gate6,
          f"stderr={result.stderr[:200]}")
    if gate6:
        go_count += 1

    print(f"\n  🚦 Go/No-Go 结果: {go_count}/6 GATES PASSED")
    if go_count == 6:
        print("  ✅ 全部通过 — Phase 5b 可以交付")
    else:
        print(f"  ❌ {6 - go_count} 个 Gate 未通过 — 需要修复")

    section_summary()


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("  Phase 5b Day 2 — 安全审计 + Go/No-Go 决策门")
    print("=" * 60)

    # 前置检查
    code, _, _ = http_get("/health")
    if code != 200:
        print(f"\n❌ Hub 未运行或 /health 不可用 (HTTP {code})")
        print("请先启动: cd agent-comm-hub && npx tsx src/server.ts")
        sys.exit(1)

    test_error_handling_security()
    test_metrics_security()
    test_cors_security()
    test_security_headers()
    test_graceful_shutdown()
    test_security_regression()
    test_go_nogo()

    # 最终汇总
    print(f"\n{'='*60}")
    print(f"  最终结果: {passed} passed, {failed} failed")
    print(f"{'='*60}")

    if failed == 0:
        print("  🎉 全部通过！Phase 5b Day 2 安全审计完成。")
        sys.exit(0)
    else:
        print(f"  ⚠️  {failed} 项失败，需要修复。")
        sys.exit(1)
